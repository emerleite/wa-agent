/**
 * Slot-based delivery with weighted pick + per-slot dedupe.
 *
 * From v0.2 onward: backed by Drizzle ORM.
 */
import { and, eq, gte, lte, isNull, notExists, or, sql } from 'drizzle-orm';
import type { DB } from '../db/client.js';
import { ads, adImpressions } from '../db/schema/slots.js';
import { messageWindows } from '../db/schema/message_windows.js';
import { leads } from '../db/schema/leads.js';

export interface SlotDeliveryOptions {
	db: DB;
}

export interface SlotItem {
	id: number;
	slug: string;
	title: string;
	body: string;
	cta_text: string | null;
	cta_url: string | null;
	video_url: string | null;
	weight: number;
}

export class SlotDelivery {
	readonly db: DB;

	constructor({ db }: SlotDeliveryOptions) {
		if (!db) throw new Error('SlotDelivery: db required');
		this.db = db;
	}

	async getActiveItems(): Promise<SlotItem[]> {
		const rows = await this.db
			.select({
				id: ads.id,
				slug: ads.slug,
				title: ads.title,
				body: ads.body,
				cta_text: ads.ctaText,
				cta_url: ads.ctaUrl,
				video_url: ads.videoUrl,
				weight: ads.weight,
			})
			.from(ads)
			.where(
				and(
					eq(ads.isActive, 1),
					or(isNull(ads.startsAt), lte(ads.startsAt, sql`datetime('now')`)),
					or(isNull(ads.endsAt), gte(ads.endsAt, sql`datetime('now')`))
				)
			);
		return rows;
	}

	async pickForUser(
		whatsapp: string,
		{ recentHours = 24, rng = Math.random }: { recentHours?: number; rng?: () => number } = {}
	): Promise<SlotItem | null> {
		const items = await this.getActiveItems();
		if (!items.length) return null;

		const cutoff = sql.raw(`(datetime('now', '-${recentHours} hours'))`);
		const recent = await this.db
			.selectDistinct({ itemId: adImpressions.itemId })
			.from(adImpressions)
			.where(and(eq(adImpressions.whatsapp, whatsapp), gte(adImpressions.sentAt, cutoff)));

		const seenIds = new Set(recent.map((r) => r.itemId));
		const fresh = items.filter((i) => !seenIds.has(i.id));
		const pool = fresh.length ? fresh : items;
		return weightedPick(pool, rng);
	}

	async recordImpression(whatsapp: string, itemId: number, slot: string): Promise<void> {
		await this.db.insert(adImpressions).values({ whatsapp, itemId, slot });
	}

	async usersForSlot(slot: string, { limit = 1000 }: { limit?: number } = {}): Promise<{ whatsapp: string }[]> {
		const rows = await this.db
			.selectDistinct({ whatsapp: messageWindows.whatsapp })
			.from(messageWindows)
			.innerJoin(leads, and(eq(leads.whatsapp, messageWindows.whatsapp), eq(leads.optIn, 1)))
			.where(
				and(
					sql`${messageWindows.endTime} > datetime('now')`,
					notExists(
						this.db
							.select({ one: sql`1` })
							.from(adImpressions)
							.where(
								and(
									eq(adImpressions.whatsapp, messageWindows.whatsapp),
									eq(adImpressions.slot, slot),
									eq(sql`date(${adImpressions.sentAt})`, sql`date('now')`)
								)
							)
					)
				)
			)
			.limit(limit);
		return rows;
	}
}

export function weightedPick<T>(items: T[], rng: () => number = Math.random): T | null {
	if (!items?.length) return null;
	const wOf = (i: T) => {
		const w = (i as { weight?: number }).weight;
		return typeof w === 'number' ? w : 1;
	};
	const total = items.reduce((s, i) => s + wOf(i), 0);
	let r = rng() * total;
	for (const i of items) {
		r -= wOf(i);
		if (r <= 0) return i;
	}
	return items[items.length - 1] ?? null;
}
