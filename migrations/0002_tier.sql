-- Transactional stream split into two tiers: 'notify' = must-deliver (sign-in, invites, payments); 'remind' = service reminders, sent from a separate domain.
-- Rows created before this migration are all 'notify'. route gains one more value: cloudflare (Cloudflare Email Sending).
ALTER TABLE messages ADD COLUMN tier TEXT NOT NULL DEFAULT 'notify' CHECK (tier IN ('notify', 'remind'));
CREATE INDEX messages_tier ON messages (tier, created_at);
