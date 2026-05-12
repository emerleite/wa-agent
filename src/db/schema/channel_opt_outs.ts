/**
 * Per-channel opt-out for recurring messages.
 *
 * Schema mirrors migrations/010_channel_opt_outs.sql.
 */
import { sqliteTable, text, index, primaryKey } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';

export const channelOptOuts = sqliteTable(
	'channel_opt_outs',
	{
		whatsapp: text('whatsapp').notNull(),
		channel: text('channel').notNull(),
		optedOutAt: text('opted_out_at').notNull().default(sql`(datetime('now'))`),
	},
	(t) => [primaryKey({ columns: [t.whatsapp, t.channel] }), index('idx_channel_opt_outs_channel').on(t.channel)]
);

export type ChannelOptOutRow = typeof channelOptOuts.$inferSelect;
