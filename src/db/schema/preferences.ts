/**
 * Per-user, per-key preferences (string values).
 *
 * Schema mirrors migrations/008_preferences.sql.
 */
import { sqliteTable, text, index, primaryKey } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';

export const userPreferences = sqliteTable(
	'user_preferences',
	{
		whatsapp: text('whatsapp').notNull(),
		key: text('key').notNull(),
		value: text('value').notNull(),
		updatedAt: text('updated_at').notNull().default(sql`(datetime('now'))`),
	},
	(t) => [primaryKey({ columns: [t.whatsapp, t.key] }), index('idx_user_preferences_key').on(t.key)]
);

export type UserPreferenceRow = typeof userPreferences.$inferSelect;
