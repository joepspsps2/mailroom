-- Unsubscribe and feedback handling.
-- unsub_reason: the optional reason a reader picks on the unsubscribe page (too_many / not_relevant / never_subscribed / other).
ALTER TABLE list_members ADD COLUMN unsub_reason TEXT;

-- Transient (soft) bounces, one row per (address, campaign). Several transient bounces in a row on different issues
-- are treated as a hard bounce; any delivery to the address clears its rows. See docs/unsubscribe.md.
CREATE TABLE bounce_streaks (
  email TEXT NOT NULL,             -- lower-case
  campaign_id TEXT NOT NULL,       -- the issue that bounced
  at TEXT NOT NULL,
  PRIMARY KEY (email, campaign_id)
);
