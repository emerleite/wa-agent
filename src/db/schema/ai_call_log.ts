/**
 * Per-call observability ledger for AIRouter (v0.9).
 *
 * Schema mirrors migrations/019_ai_call_log.sql.
 */
import { sqliteTable, text, integer, index } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';

export const aiCallLog = sqliteTable(
	'ai_call_log',
	{
		id: text('id').primaryKey(),
		task: text('task').notNull(),
		provider: text('provider').notNull(),
		model: text('model'),
		status: text('status').notNull(),
		httpStatus: integer('http_status'),
		latencyMs: integer('latency_ms'),
		tokensIn: integer('tokens_in'),
		tokensOut: integer('tokens_out'),
		estCostMicroUsd: integer('est_cost_micro_usd'),
		errorKind: text('error_kind'),
		errorMessage: text('error_message'),
		tenantId: text('tenant_id'),
		whatsapp: text('whatsapp'),
		createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
	},
	(t) => [
		index('idx_ai_call_log_provider_day').on(t.provider, t.createdAt),
		index('idx_ai_call_log_task_day').on(t.task, t.createdAt),
		index('idx_ai_call_log_status_day').on(t.status, t.createdAt),
		index('idx_ai_call_log_tenant_day').on(t.tenantId, t.createdAt),
	],
);

export type AICallLogRow = typeof aiCallLog.$inferSelect;
