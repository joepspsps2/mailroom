-- Click / open tracking. Additive only: existing rows and code paths are unchanged.

-- Each issue's link table: JSON [{ "index": 1, "url": "https://…" }, …] (compose()'s links, final URLs).
-- The click redirect only goes to a URL in this table. NULL = the issue has no tracked links (older issues).
ALTER TABLE campaigns ADD COLUMN links TEXT;
