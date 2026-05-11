/**
 * Meta 24h/72h customer-service window tracker.
 *
 * Schema mirrors migrations/002_users.sql.
 */
import { sqliteTable, integer, text, index } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';

export const messageWindows = sqliteTable(
	'message_windows',
	{
		id: integer('id').primaryKey({ autoIncrement: true }),
		whatsapp: text('whatsapp').unique().notNull(),
		windowType: text('window_type', { enum: ['free', 'paid'] }).notNull(),
		startTime: text('start_time').notNull().default(sql`(datetime('now'))`),
		endTime: text('end_time').notNull(),
	},
	(t) => [index('idx_message_windows_end_time').on(t.endTime)]
);

export type MessageWindow = typeof messageWindows.$inferSelect;
export type NewMessageWindow = typeof messageWindows.$inferInsert;
