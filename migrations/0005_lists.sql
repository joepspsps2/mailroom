-- Newsletter lists. One contact row per address (shared by every list); one list_members row per (list, contact).
-- Per-list unsubscribe lives in list_members. The global suppressions table only holds hard bounces, complaints and "no newsletters at all".
CREATE TABLE contacts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE,      -- always lower-case, trimmed
  name TEXT,
  attrs TEXT,                      -- JSON: personalisation fields
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE lists (
  id TEXT PRIMARY KEY,             -- e.g. weekly
  name TEXT NOT NULL,
  from_addr TEXT,
  reply_to TEXT,
  welcome_template TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE list_members (
  list_id TEXT NOT NULL REFERENCES lists (id),
  contact_id INTEGER NOT NULL REFERENCES contacts (id),
  status TEXT NOT NULL CHECK (status IN ('subscribed', 'unsubscribed')),
  subscribed_at TEXT,
  unsubscribed_at TEXT,
  unsub_source TEXT,               -- link / one_click / api / import / import-removed / complaint
  source TEXT,                     -- which entry point the person came in through (free text, set by the caller)
  consent_version TEXT,
  segment TEXT,                    -- engagement group, copied in from the analytics side; the engine never recomputes it
  segment_label TEXT,
  segment_at TEXT,
  imported_from TEXT,
  last_open_at TEXT,
  last_click_at TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (list_id, contact_id)
);
CREATE INDEX list_members_contact ON list_members (contact_id);
CREATE INDEX list_members_status ON list_members (list_id, status, contact_id);
CREATE INDEX list_members_segment ON list_members (list_id, segment);
