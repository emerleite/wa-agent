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
		/**
		 * Multi-tenant scoping (v0.6+). NULL for single-tenant deployments —
		 * the IS NULL filter in `claimBatch()` preserves their bit-for-bit
		 * behavior. Populated for tenants behind `MultiTenantAgentRegistry`.
		 */
		tenantId: text('tenant_id'),
	},
	(t) => [
		index('idx_mq_pending_scheduled').on(t.status, t.scheduledAt),
		index('idx_mq_whatsapp_pending').on(t.whatsapp, t.status),
		index('idx_mq_claim').on(t.whatsapp, t.status, t.startedAt),
		index('idx_message_queue_tenant').on(t.tenantId, t.status, t.scheduledAt),
	]
);

export type MessageQueueRow = typeof messageQueue.$inferSelect;
export type NewMessageQueueRow = typeof messageQueue.$inferInsert;
