-- wa-agent: per-channel opt-out for recurring messages.
--
-- Different from leads.opt_in (which pauses the whole bot). This lets a
-- user mute specific channels (e.g. devotional) while continuing to
-- receive others (e.g. reading plan). Default state is "subscribed" —
-- absence of a row = the channel is enabled. INSERT to mute, DELETE to
-- re-enable.
--
-- Backs `ChannelOptOuts`.

CREATE TABLE IF NOT EXISTS channel_opt_outs (
	whatsapp TEXT NOT NULL,
	channel TEXT NOT NULL,
	opted_out_at TEXT NOT NULL DEFAULT (datetime('now')),
	PRIMARY KEY (whatsapp, channel)
);

CREATE INDEX IF NOT EXISTS idx_channel_opt_outs_channel ON channel_opt_outs (channel);
