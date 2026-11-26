-- Welcome mail for new subscribers. Additive only.

-- One welcome mail per list. Composed outside the Worker (like an issue) and stored once. The engine adds the
-- List-Unsubscribe headers itself when sending.
-- enabled = 0 until someone switches it on explicitly; a list without a row (or with enabled = 0) sends no welcome mail.
CREATE TABLE welcome_mails (
  list_id TEXT PRIMARY KEY REFERENCES lists (id),
  subject TEXT NOT NULL,
  from_addr TEXT NOT NULL,
  reply_to TEXT,
  html TEXT NOT NULL,
  text TEXT NOT NULL,
  web_url TEXT NOT NULL,               -- the {{web_url}} placeholder (e.g. the newsletter's archive page)
  content_hash TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);
