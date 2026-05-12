/**
 * Broadcast delivery audit log + re-engagement answers.
 *
 * Schema mirrors migrations/004_broadcast.sql.
 */
import { sqliteTable, integer, text, index, unique } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';

export const broadcastLog = sqliteTable(
	'broadcast_log',
	{
		id: integer('id').primaryKey({ autoIncrement: true }),
		whatsapp: text('whatsapp').notNull(),
		channel: text('channel').notNull(),
		date: text('date').notNull(),
		createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
	},
	(t) => [unique().on(t.whatsapp, t.channel, t.date), index('idx_broadcast_log_lookup').on(t.whatsapp, t.channel, t.date)]
);

export const engagementAnswers = sqliteTable(
	'engagement_answers',
	{
		id: integer('id').primaryKey({ autoIncrement: true }),
		engagementId: integer('engagement_id').notNull(),
		whatsapp: text('whatsapp').notNull(),
		answer: text('answer').notNull(),
		date: text('date').notNull(),
		createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
	},
	(t) => [
		index('idx_engagement_answers_lookup').on(t.engagementId, t.whatsapp, t.date),
		index('idx_engagement_answers_date').on(t.date),
	]
);

export type BroadcastLogRow = typeof broadcastLog.$inferSelect;
export type EngagementAnswerRow = typeof engagementAnswers.$inferSelect;
