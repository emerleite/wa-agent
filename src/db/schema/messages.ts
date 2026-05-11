/**
 * Inbound + outbound message audit log.
 *
 * Schema mirrors migrations/001_core.sql. From v0.2 onward, schema files in
 * src/db/schema/ are the source of truth; pre-v0.2 SQL migrations are frozen.
 */
import { sqliteTable, integer, text, index } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';

export const messages = sqliteTable(
	'messages',
	{
		id: integer('id').primaryKey({ autoIncrement: true }),
		wamid: text('wamid').unique(),
		whatsapp: text('whatsapp'),
		threadId: text('thread_id'),
		type: text('type'),
		payload: text('payload'),
		body: text('body'),
		response: text('response'),
		summary: text('summary'),
		feedback: text('feedback'),
		createdAt: text('created_at').default(sql`CURRENT_TIMESTAMP`),
		updatedAt: text('updated_at').default(sql`CURRENT_TIMESTAMP`),
	},
	(t) => [
		index('idx_messages_whatsapp').on(t.whatsapp),
		index('idx_messages_wamid').on(t.wamid),
		index('idx_messages_created_at').on(t.createdAt),
	]
);

export type Message = typeof messages.$inferSelect;
export type NewMessage = typeof messages.$inferInsert;
