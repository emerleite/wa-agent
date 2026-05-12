/**
 * Per-user, per-feature usage log (daily caps + analytics).
 *
 * Schema mirrors migrations/007_usage.sql.
 */
import { sqliteTable, integer, text, index } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';

export const featureUsage = sqliteTable(
	'feature_usage',
	{
		id: integer('id').primaryKey({ autoIncrement: true }),
		whatsapp: text('whatsapp').notNull(),
		feature: text('feature').notNull(),
		key: text('key'),
		usedAt: text('used_at').notNull().default(sql`(datetime('now'))`),
	},
	(t) => [index('idx_feature_usage_user').on(t.whatsapp, t.feature, t.usedAt), index('idx_feature_usage_feature').on(t.feature, t.usedAt)]
);

export type FeatureUsageRow = typeof featureUsage.$inferSelect;
