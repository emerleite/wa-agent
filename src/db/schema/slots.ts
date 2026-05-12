/**
 * Slot-based content delivery (ads, tips, daily picks) + per-user impressions.
 *
 * Schema mirrors migrations/006_slots.sql.
 */
import { sqliteTable, integer, text, index } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';

export const ads = sqliteTable(
	'ads',
	{
		id: integer('id').primaryKey({ autoIncrement: true }),
		slug: text('slug').unique().notNull(),
		title: text('title').notNull(),
		body: text('body').notNull(),
		ctaText: text('cta_text'),
		ctaUrl: text('cta_url'),
		videoUrl: text('video_url'),
		weight: integer('weight').notNull().default(1),
		isActive: integer('is_active').notNull().default(1),
		startsAt: text('starts_at'),
		endsAt: text('ends_at'),
		createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
	},
	(t) => [index('idx_ads_active').on(t.isActive)]
);

export const adImpressions = sqliteTable(
	'ad_impressions',
	{
		id: integer('id').primaryKey({ autoIncrement: true }),
		whatsapp: text('whatsapp').notNull(),
		itemId: integer('item_id').notNull(),
		slot: text('slot'),
		sentAt: text('sent_at').notNull().default(sql`(datetime('now'))`),
	},
	(t) => [index('idx_ad_impressions_user').on(t.whatsapp, t.sentAt), index('idx_ad_impressions_slot').on(t.slot, t.sentAt)]
);

export type AdRow = typeof ads.$inferSelect;
export type AdImpressionRow = typeof adImpressions.$inferSelect;
