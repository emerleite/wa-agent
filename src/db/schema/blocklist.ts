/**
 * Per-number abuse blocklist.
 *
 * Schema mirrors migrations/011_blocklist.sql.
 */
import { sqliteTable, text, index } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';

export const blockedNumbers = sqliteTable(
	'blocked_numbers',
	{
		whatsapp: text('whatsapp').primaryKey(),
		reason: text('reason').notNull(),
		blockedAt: text('blocked_at').notNull().default(sql`(datetime('now'))`),
		blockedBy: text('blocked_by'),
		expiresAt: text('expires_at'),
		notes: text('notes'),
	},
	(t) => [index('idx_blocked_expires').on(t.expiresAt)]
);

export type BlockedNumberRow = typeof blockedNumbers.$inferSelect;
