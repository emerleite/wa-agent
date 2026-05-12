/**
 * D1-backed message-coalescing queue.
 *
 * Schema mirrors migrations/003_queue.sql.
 */
import { sqliteTable, integer, text, index } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';

export const messageQueue = sqliteTable(
	'message_queue',
	{
		id: integer('id').primaryKey({ autoIncrement: true }),
		messageId: text('message_id').unique(),
		whatsapp: text('whatsapp').notNull(),
		payload: text('payload').notNull(),
		status: text('status', { enum: ['pending', 'processing', 'done', 'failed'] })
			.notNull()
			.default('pending'),
		attempts: integer('attempts').notNull().default(0),
		scheduledAt: text('scheduled_at').notNull().default(sql`(datetime('now', '+3 seconds'))`),
		createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
		startedAt: text('started_at'),
		completedAt: text('completed_at'),
		errorMessage: text('error_message'),
	},
	(t) => [
		index('idx_mq_pending_scheduled').on(t.status, t.scheduledAt),
		index('idx_mq_whatsapp_pending').on(t.whatsapp, t.status),
		index('idx_mq_claim').on(t.whatsapp, t.status, t.startedAt),
	]
);

export type MessageQueueRow = typeof messageQueue.$inferSelect;
export type NewMessageQueueRow = typeof messageQueue.$inferInsert;
