/**
 * Slot-based delivery with weighted pick + per-slot dedupe.
 */
export interface SlotDeliveryOptions {
	db: D1Database;
	itemTable?: string;
	impressionTable?: string;
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
	readonly db: D1Database;
	readonly itemTable: string;
	readonly impressionTable: string;

	constructor({ db, itemTable = 'ads', impressionTable = 'ad_impressions' }: SlotDeliveryOptions) {
		if (!db) throw new Error('SlotDelivery: db required');
		this.db = db;
		this.itemTable = itemTable;
		this.impressionTable = impressionTable;
	}

	async getActiveItems(): Promise<SlotItem[]> {
		const r = await this.db
			.prepare(
				`SELECT id, slug, title, body, cta_text, cta_url, video_url, weight
				 FROM ${this.itemTable}
				 WHERE is_active = 1
				   AND (starts_at IS NULL OR starts_at <= datetime('now'))
				   AND (ends_at   IS NULL OR ends_at   >= datetime('now'))`
			)
			.all<SlotItem>();
		return r.results ?? [];
	}

	async pickForUser(whatsapp: string, { recentHours = 24, rng = Math.random }: { recentHours?: number; rng?: () => number } = {}): Promise<SlotItem | null> {
		const items = await this.getActiveItems();
		if (!items.length) return null;
		const recent = await this.db
			.prepare(
				`SELECT DISTINCT item_id FROM ${this.impressionTable}
				 WHERE whatsapp = ? AND sent_at >= datetime('now', '-' || ? || ' hours')`
			)
			.bind(whatsapp, recentHours)
			.all<{ item_id: number }>();
		const seenIds = new Set((recent.results ?? []).map((r) => r.item_id));
		const fresh = items.filter((i) => !seenIds.has(i.id));
		const pool = fresh.length ? fresh : items;
		return weightedPick(pool, rng);
	}

	async recordImpression(whatsapp: string, itemId: number, slot: string): Promise<void> {
		await this.db
			.prepare(`INSERT INTO ${this.impressionTable} (whatsapp, item_id, slot) VALUES (?, ?, ?)`)
			.bind(whatsapp, itemId, slot)
			.run();
	}

	async usersForSlot(slot: string, { limit = 1000 }: { limit?: number } = {}): Promise<{ whatsapp: string }[]> {
		const r = await this.db
			.prepare(
				`SELECT DISTINCT mw.whatsapp
				 FROM message_windows mw
				 JOIN leads l ON l.whatsapp = mw.whatsapp AND l.opt_in = 1
				 WHERE mw.end_time > datetime('now')
				   AND NOT EXISTS (
					 SELECT 1 FROM ${this.impressionTable} ai
					 WHERE ai.whatsapp = mw.whatsapp
					   AND ai.slot = ?
					   AND date(ai.sent_at) = date('now')
				   )
				 LIMIT ?`
			)
			.bind(slot, limit)
			.all<{ whatsapp: string }>();
		return r.results ?? [];
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
