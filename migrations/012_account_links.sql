-- wa-agent: account linking — redeem a short-lived web-issued code to map
-- a web identity to a WhatsApp number.
--
-- Flow: a website signed-in user (or push subscriber) clicks "connect
-- WhatsApp", the site generates a 6-digit code and stores it hashed in
-- `account_link_codes`. The user types `link <code>` (or whatever phrase
-- the bot wires up) and the bot verifies, then writes a row in
-- `account_links` mapping the web identity to the whatsapp number.
--
-- Why hashed: a DB dump should not expose redeem-able codes. The website
-- and the bot both SHA-256 the digits — only the hash is persisted.
--
-- Why two tables: `account_link_codes` is short-lived (codes expire in
-- minutes) and single-use; `account_links` is the long-lived mapping the
-- application reads to render "your bot progress on /me".
--
-- identity_kind partitions the space — different products will want
-- different identity sources (e.g. 'google_sub', 'push_endpoint',
-- 'github_id'). The bot side keeps an allowlist to refuse unknown kinds
-- (no CHECK constraint here so existing rows survive an allowlist
-- expansion without an ALTER).

CREATE TABLE IF NOT EXISTS account_link_codes (
	id              INTEGER PRIMARY KEY AUTOINCREMENT,
	code_hash       TEXT NOT NULL UNIQUE,
	identity_kind   TEXT NOT NULL,
	identity_value  TEXT NOT NULL,
	created_at      INTEGER NOT NULL,
	expires_at      INTEGER NOT NULL,
	used_at         INTEGER,
	used_by_whatsapp TEXT
);
CREATE INDEX IF NOT EXISTS idx_account_link_codes_expires ON account_link_codes (expires_at);
CREATE INDEX IF NOT EXISTS idx_account_link_codes_identity ON account_link_codes (identity_kind, identity_value);

CREATE TABLE IF NOT EXISTS account_links (
	id              INTEGER PRIMARY KEY AUTOINCREMENT,
	whatsapp        TEXT NOT NULL,
	identity_kind   TEXT NOT NULL,
	identity_value  TEXT NOT NULL,
	linked_at       INTEGER NOT NULL,
	last_seen_at    INTEGER NOT NULL,
	UNIQUE (identity_kind, identity_value)
);
CREATE INDEX IF NOT EXISTS idx_account_links_whatsapp ON account_links (whatsapp);
