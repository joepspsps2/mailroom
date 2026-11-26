-- Newsletter broadcasting: issues (campaigns), the frozen recipient list, provider events, daily throttle counters,
-- warm-up ladder steps and sender-domain holds. Also lets the ledger record newsletter sends (tier 'marketing').

-- 1. The ledger's tier column only allowed 'notify' / 'remind'. SQLite cannot alter a CHECK constraint, so the table is
--    rebuilt with the same columns and rows. Newsletter sends are one ledger row per recipient (stream 'marketing',
--    tier 'marketing'), idempotency key c:{issue}:{contact}.
CREATE TABLE messages_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  stream TEXT NOT NULL CHECK (stream IN ('transactional', 'marketing')),
  site TEXT NOT NULL,
  dedupe_key TEXT NOT NULL,
  kind TEXT,
  to_email TEXT NOT NULL,
  from_addr TEXT NOT NULL,
  subject TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('sending', 'sent', 'failed', 'suppressed')),
  route TEXT,                    -- resend / smtp2go / cloudflare, or the newsletter postman's name (fake / ses / ...)
  provider_id TEXT,
  error TEXT,
  attempts INTEGER NOT NULL DEFAULT 1,
  last_event TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  sent_at TEXT,
  tier TEXT NOT NULL DEFAULT 'notify' CHECK (tier IN ('notify', 'remind', 'marketing')),
  last_error TEXT,
  UNIQUE (site, dedupe_key)
);
INSERT INTO messages_new (id, stream, site, dedupe_key, kind, to_email, from_addr, subject, status, route, provider_id, error, attempts, last_event, created_at, updated_at, sent_at, tier, last_error)
  SELECT id, stream, site, dedupe_key, kind, to_email, from_addr, subject, status, route, provider_id, error, attempts, last_event, created_at, updated_at, sent_at, tier, last_error FROM messages;
DROP TABLE messages;
ALTER TABLE messages_new RENAME TO messages;
CREATE INDEX messages_to ON messages (to_email, created_at);
CREATE INDEX messages_provider ON messages (provider_id);
CREATE INDEX messages_created ON messages (created_at);
CREATE INDEX messages_tier ON messages (tier, created_at);
CREATE INDEX messages_marketing_sent ON messages (site, stream, sent_at);

-- 2. One row per newsletter issue. The HTML is stored once here, never per recipient.
-- status: draft -> approved -> scheduled -> sending <-> paused -> done; cancelled from draft/approved/scheduled/paused.
CREATE TABLE campaigns (
  id TEXT PRIMARY KEY,                 -- e.g. weekly-162
  list_id TEXT NOT NULL REFERENCES lists (id),
  subject TEXT NOT NULL,
  preheader TEXT,
  from_addr TEXT NOT NULL,
  reply_to TEXT,
  html TEXT NOT NULL,
  text TEXT NOT NULL,
  headers TEXT,                        -- JSON: extra headers with placeholders (e.g. List-Unsubscribe), filled per recipient
  source_ref TEXT,                     -- where the source came from (path and commit)
  status TEXT NOT NULL CHECK (status IN ('draft', 'approved', 'scheduled', 'sending', 'paused', 'done', 'cancelled')),
  audience TEXT NOT NULL,              -- JSON: { "plan": "<warm-up plan>" } or { "waves": [["seg", ...], ...], "maxCount": n }
  audience_resolved TEXT,              -- JSON: the waves actually used, fixed when the list is frozen
  content_hash TEXT NOT NULL,          -- hash of everything a reader sees; approval and pre-send check are tied to it
  approved_hash TEXT,
  approved_at TEXT,
  approved_note TEXT,                  -- who approved, when, where
  preflight TEXT,                      -- JSON: { ok, hash, at, errors } from the pre-send check
  scheduled_at TEXT,
  started_at TEXT,
  frozen_at TEXT,                      -- set in the same batch that writes campaign_recipients
  last_release_at TEXT,
  last_progress_at TEXT,
  finished_at TEXT,
  pause_reason TEXT,
  counts TEXT,                         -- JSON cache for status pages
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX campaigns_status ON campaigns (status, scheduled_at);

-- 3. The frozen list: who this issue is for, fixed at the moment sending starts.
-- state: planned -> enqueued -> done | skipped | failed | uncertain (sent-or-not unknown after a crash; never re-sent automatically).
CREATE TABLE campaign_recipients (
  campaign_id TEXT NOT NULL REFERENCES campaigns (id),
  contact_id INTEGER NOT NULL,
  email TEXT NOT NULL,
  segment TEXT,
  wave INTEGER,                        -- 1-based; NULL when not part of this issue's audience
  rank INTEGER NOT NULL DEFAULT 0,     -- order inside the wave (segment order of the audience)
  state TEXT NOT NULL CHECK (state IN ('planned', 'enqueued', 'done', 'skipped', 'failed', 'uncertain')),
  skip_reason TEXT,                    -- suppressed / unsubscribed / warmup / cancelled
  attempts INTEGER NOT NULL DEFAULT 0,
  message_id INTEGER,                  -- ledger row (messages.id)
  error TEXT,
  enqueued_at TEXT,
  done_at TEXT,
  PRIMARY KEY (campaign_id, contact_id)
);
CREATE INDEX campaign_recipients_queue ON campaign_recipients (campaign_id, state, wave, rank, contact_id);
CREATE INDEX campaign_recipients_message ON campaign_recipients (message_id);

-- 4. Provider feedback, one row per event. provider_event_id de-duplicates re-deliveries.
CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider TEXT NOT NULL,              -- fake / ses / resend / self
  provider_event_id TEXT NOT NULL UNIQUE,
  message_id INTEGER,
  provider_message_id TEXT,            -- the provider's id for the mail (two different ids for one person in one issue = sent twice)
  campaign_id TEXT,
  contact_id INTEGER,
  type TEXT NOT NULL CHECK (type IN ('send', 'delivery', 'bounce', 'complaint', 'reject', 'delay', 'open', 'click', 'unsubscribe')),
  subtype TEXT,                        -- bounce: Permanent / Transient / Undetermined
  at TEXT NOT NULL,
  detail TEXT,                         -- JSON
  exported_at TEXT
);
CREATE INDEX events_campaign ON events (campaign_id, type, contact_id);
CREATE INDEX events_message ON events (message_id, type);
CREATE INDEX events_export ON events (exported_at, id);

-- 5. Per sender domain, per local day: how many newsletter mails were reserved/sent and the day's ceiling.
CREATE TABLE throttle_days (
  domain TEXT NOT NULL,
  day TEXT NOT NULL,                   -- local date (configured offset, default +8)
  sent INTEGER NOT NULL DEFAULT 0,
  "limit" INTEGER NOT NULL,
  per_second REAL NOT NULL DEFAULT 1,
  provider_per_day INTEGER,
  enforcement TEXT,
  paused INTEGER NOT NULL DEFAULT 0,   -- 1 = the day's ceiling was reached
  reason TEXT,
  refreshed_at TEXT,
  last_throttled_at TEXT,
  PRIMARY KEY (domain, day)
);

-- 6. Warm-up ladder. segments = waves (JSON array of arrays of segment names, "*" = everyone not matched earlier).
CREATE TABLE warmup_steps (
  plan_id TEXT NOT NULL,
  step INTEGER NOT NULL,
  segments TEXT NOT NULL,
  max_count INTEGER,
  gate TEXT,                           -- JSON overrides for the pass conditions
  released_at TEXT,                    -- when this step became the current one (step 1 is current without release)
  blocked_reason TEXT,                 -- set after too many failed gates in a row; cleared only by an explicit unblock
  fails INTEGER NOT NULL DEFAULT 0,
  last_eval TEXT,                      -- JSON: last evaluated issue and result
  PRIMARY KEY (plan_id, step)
);

-- 7. Sender-domain stop ("emergency brake"). Active while released_at is NULL; only an explicit release lifts it.
CREATE TABLE domain_holds (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  domain TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL,
  released_at TEXT,
  released_note TEXT
);
CREATE INDEX domain_holds_active ON domain_holds (domain, released_at);
