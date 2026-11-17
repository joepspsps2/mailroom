-- Rate counters for the public HTTP entry point (clients holding an API key): one row per client per time window.
-- Incremented and read back in a single statement (atomic), so concurrent requests cannot overshoot the limit.
-- win examples: m:2026-01-01T10:05 (per minute), d:2026-01-01 (per UTC day).
CREATE TABLE rate_counters (
  site TEXT NOT NULL,
  win TEXT NOT NULL,
  n INTEGER NOT NULL,
  PRIMARY KEY (site, win)
);
