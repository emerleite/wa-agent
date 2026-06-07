/**
 * Structured escalation log.
 *
 * Schema mirrors migrations/013_escalations.sql.
 */
import { sqliteTable, text, index } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';

export const escalations = sqliteTable(
	'escalations',
	{
		id: text('id').primaryKey(),
		whatsapp: text('whatsapp').notNull(),
		reason: text('reason').notNull(),
		urgency: text('urgency').notNull(),
		message: text('message').notNull(),
		traceId: text('trace_id'),
		tenantId: text('tenant_id'),
		createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
		resolvedAt: text('resolved_at'),
		resolvedBy: text('resolved_by'),
		notes: text('notes'),
	},
	(t) => [
		index('idx_escalations_open').on(t.resolvedAt, t.urgency, t.createdAt),
		index('idx_escalations_whatsapp').on(t.whatsapp, t.createdAt),
		index('idx_escalations_tenant').on(t.tenantId, t.createdAt),
	]
);

export type EscalationRow = typeof escalations.$inferSelect;
