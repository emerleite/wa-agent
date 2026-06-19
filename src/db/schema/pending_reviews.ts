/**
 * Human-review queue for `assisted` mode.
 *
 * Schema mirrors migrations/018_pending_reviews.sql.
 */
import { sqliteTable, text, index } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';

export const pendingReviews = sqliteTable(
	'pending_reviews',
	{
		id: text('id').primaryKey(),
		whatsapp: text('whatsapp').notNull(),
		aiText: text('ai_text').notNull(),
		editedText: text('edited_text'),
		status: text('status').notNull().default('pending'),
		wamid: text('wamid'),
		traceId: text('trace_id'),
		tenantId: text('tenant_id'),
		threadId: text('thread_id'),
		createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
		approvedAt: text('approved_at'),
		approvedBy: text('approved_by'),
		sentAt: text('sent_at'),
	},
	(t) => [
		index('idx_pending_reviews_status').on(t.status, t.createdAt),
		index('idx_pending_reviews_tenant').on(t.tenantId, t.status, t.createdAt),
		index('idx_pending_reviews_whatsapp').on(t.whatsapp, t.status),
	]
);

export type PendingReviewRow = typeof pendingReviews.$inferSelect;
