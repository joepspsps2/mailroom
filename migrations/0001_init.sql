-- Ledger: one row per message. Message bodies are never stored — only who it went to, who sent it, which provider carried it, and the outcome.
CREATE TABLE messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  -- stream: 'transactional' = notifications (open); 'marketing' = newsletters (not implemented yet, always rejected)
  stream TEXT NOT NULL CHECK (stream IN ('transactional', 'marketing')),
  site TEXT NOT NULL,            -- which client app sent it, e.g. billing
  dedupe_key TEXT NOT NULL,      -- idempotency key: one send per (site, key); also forwarded to Resend as Idempotency-Key
  kind TEXT,                     -- the client's own message type, e.g. approval_needed, digest, invite
  to_email TEXT NOT NULL,        -- always lower-case
  from_addr TEXT NOT NULL,
  subject TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('sending', 'sent', 'failed', 'suppressed')),
  route TEXT,                    -- resend / smtp2go / cloudflare
  provider_id TEXT,              -- message id returned by the provider (used to match bounce webhooks back to this row)
  error TEXT,
  attempts INTEGER NOT NULL DEFAULT 1,
  last_event TEXT,               -- provider feedback: delivered / bounced / complained / failed
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  sent_at TEXT,
  UNIQUE (site, dedupe_key)
);
CREATE INDEX messages_to ON messages (to_email, created_at);
CREATE INDEX messages_provider ON messages (provider_id);
CREATE INDEX messages_created ON messages (created_at);

-- Suppression list, one row per (email, reason). hard_bounce and complaint block every stream; unsubscribe only blocks marketing.
CREATE TABLE suppressions (
  email TEXT NOT NULL,
  reason TEXT NOT NULL CHECK (reason IN ('hard_bounce', 'complaint', 'unsubscribe')),
  source TEXT NOT NULL,          -- resend-webhook / cloudflare-event / manual / import
  detail TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (email, reason)
);

-- Webhook de-duplication: a provider re-delivering the same event (same svix-id) is processed once.
CREATE TABLE webhook_events (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  received_at TEXT NOT NULL
);
