/**
 * Cross-category pacing ledger for bot-initiated sends (v0.9.1).
 *
 * Schema mirrors migrations/020_bot_send_log.sql.
 */
import { sqliteTable, text, integer, index } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';

export const botSendLog = sqliteTable(
	'bot_send_log',
	{
		id: integer('id').primaryKey({ autoIncrement: true }),
		whatsapp: text('whatsapp').notNull(),
		category: text('category').notNull(),
		tenantId: text('tenant_id'),
		sentAt: text('sent_at').notNull().default(sql`(datetime('now'))`),
		date: text('date').notNull().default(sql`(date('now'))`),
	},
	(t) => [
		index('idx_bot_send_log_whatsapp_date').on(t.whatsapp, t.date),
		index('idx_bot_send_log_whatsapp_sent_at').on(t.whatsapp, t.sentAt),
		index('idx_bot_send_log_tenant_date').on(t.tenantId, t.date),
	],
);

export type BotSendLogRow = typeof botSendLog.$inferSelect;
