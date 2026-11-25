-- Keep the previous failure reason after a retry succeeds: when a failed row is claimed again, its error is copied to last_error before error is cleared.
ALTER TABLE messages ADD COLUMN last_error TEXT;
