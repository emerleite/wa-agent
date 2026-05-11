/**
 * Per-user AI thread state.
 *
 * Schema mirrors migrations/001_core.sql.
 */
import { sqliteTable, integer, text, index } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';

export const sessions = sqliteTable(
	'sessions',
	{
		id: integer('id').primaryKey({ autoIncrement: true }),
		threadId: text('thread_id').unique(),
		whatsapp: text('whatsapp').unique(),
		createdAt: text('created_at').default(sql`CURRENT_TIMESTAMP`),
		updatedAt: text('updated_at').default(sql`CURRENT_TIMESTAMP`),
	},
	(t) => [index('idx_sessions_whatsapp').on(t.whatsapp), index('idx_sessions_thread_id').on(t.threadId)]
);

export type Session = typeof sessions.$inferSelect;
export type NewSession = typeof sessions.$inferInsert;
