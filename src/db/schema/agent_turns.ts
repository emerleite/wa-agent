/**
 * Conversation memory for AgentLoop (v0.11).
 *
 * Schema mirrors migrations/022_agent_turns.sql.
 */
import { sqliteTable, text, integer, index } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';

export const agentTurns = sqliteTable(
	'agent_turns',
	{
		id: text('id').primaryKey(),
		turnId: text('turn_id').notNull(),
		whatsapp: text('whatsapp').notNull(),
		stepIndex: integer('step_index').notNull(),
		role: text('role').notNull(),
		content: text('content').notNull(),
		toolCallsJson: text('tool_calls_json'),
		toolCallId: text('tool_call_id'),
		toolName: text('tool_name'),
		tenantId: text('tenant_id'),
		createdAt: text('created_at')
			.notNull()
			.default(sql`(datetime('now'))`),
	},
	(t) => [
		index('idx_agent_turns_user_time').on(t.whatsapp, t.createdAt),
		index('idx_agent_turns_turn_step').on(t.turnId, t.stepIndex),
		index('idx_agent_turns_tenant_user_time').on(t.tenantId, t.whatsapp, t.createdAt),
	],
);

export type AgentTurnRow = typeof agentTurns.$inferSelect;
