/**
 * Per-WhatsApp-number abuse blocklist.
 *
 * Hot-path primitive: every inbound message can be checked against it
 * cheaply via the per-isolate cache (5-minute TTL by default). New blocks
 * propagate across isolates within ≤TTL without external coordination.
 *
 * The cache stores BOTH positive (blocked) and negative (not-blocked)
 * decisions, so the common case (everyone is not blocked) is also a hit.
 *
 * Fail-open on D1 errors: a blocklist outage must not take the whole bot
 * down. False-negatives during such windows are recovered by the cache
 * TTL once D1 recovers.
 *
 * From v0.2 onward: backed by Drizzle ORM.
 */
import { and, desc, eq, isNull, gt, lt, or, sql } from 'drizzle-orm';
import type { DB } from '../db/client.js';
import { blockedNumbers, type BlockedNumberRow } from '../db/schema/blocklist.js';

export interface BlocklistOptions {
	db: DB;
	/** Cache TTL in ms. Default 5 minutes. Set 0 to disable caching. */
	cacheTtlMs?: number;
}

export interface BlockArgs {
	whatsapp: string;
	reason: string;
	blockedBy?: string | null;
	/** ISO datetime ("YYYY-MM-DD HH:MM:SS"). NULL = permanent. */
	expiresAt?: string | null;
	notes?: string | null;
}

export interface ListBlockedOptions {
	/** When true (default), excludes expired rows. */
	activeOnly?: boolean;
	limit?: number;
}

interface CacheEntry {
	blocked: boolean;
	expiresAt: number;
}

export class Blocklist {
	readonly db: DB;
	readonly cacheTtlMs: number;
	private readonly cache = new Map<string, CacheEntry>();

	constructor({ db, cacheTtlMs = 5 * 60 * 1000 }: BlocklistOptions) {
		if (!db) throw new Error('Blocklist: db required');
		this.db = db;
		this.cacheTtlMs = cacheTtlMs;
	}

	/**
	 * @returns true if `whatsapp` has an active (non-expired) block.
	 *
	 * Cache-first. On D1 error, returns false (fail-open).
	 */
	async isBlocked(whatsapp: string): Promise<boolean> {
		if (!whatsapp) return false;
		const cached = this.cacheGet(whatsapp);
		if (cached !== null) return cached;

		try {
			const r = await this.db
				.select({ one: sql`1` })
				.from(blockedNumbers)
				.where(and(eq(blockedNumbers.whatsapp, whatsapp), or(isNull(blockedNumbers.expiresAt), gt(blockedNumbers.expiresAt, sql`datetime('now')`))))
				.limit(1);
			const blocked = r.length > 0;
			this.cachePut(whatsapp, blocked);
			return blocked;
		} catch (e) {
			console.error('[Blocklist] isBlocked:', e instanceof Error ? e.message : e);
			return false;
		}
	}

	/**
	 * Insert or overwrite a block. Latest reason / blockedBy / expiresAt / notes win;
	 * `blocked_at` is refreshed on overwrite (matches bibliafala's behavior).
	 */
	async block({ whatsapp, reason, blockedBy = null, expiresAt = null, notes = null }: BlockArgs): Promise<void> {
		if (!whatsapp || !reason) throw new Error('Blocklist.block: whatsapp + reason required');
		await this.db
			.insert(blockedNumbers)
			.values({ whatsapp, reason, blockedBy, expiresAt, notes })
			.onConflictDoUpdate({
				target: blockedNumbers.whatsapp,
				set: {
					reason,
					blockedBy,
					expiresAt,
					notes,
					blockedAt: sql`(datetime('now'))`,
				},
			});
		this.cacheBust(whatsapp);
	}

	/**
	 * Remove a block. Idempotent — returns true if a row was deleted, false otherwise.
	 */
	async unblock(whatsapp: string): Promise<boolean> {
		if (!whatsapp) return false;
		const r = await this.db.delete(blockedNumbers).where(eq(blockedNumbers.whatsapp, whatsapp)).returning({ whatsapp: blockedNumbers.whatsapp });
		this.cacheBust(whatsapp);
		return r.length > 0;
	}

	/**
	 * List blocked numbers for admin UI / triage. Defaults to active only.
	 */
	async listBlocked({ activeOnly = true, limit = 200 }: ListBlockedOptions = {}): Promise<BlockedNumberRow[]> {
		const q = this.db.select().from(blockedNumbers).orderBy(desc(blockedNumbers.blockedAt)).limit(limit);
		if (activeOnly) {
			return await q.where(or(isNull(blockedNumbers.expiresAt), gt(blockedNumbers.expiresAt, sql`datetime('now')`)));
		}
		return await q;
	}

	/**
	 * Sweep expired rows. Optional — `isBlocked()` ignores them automatically.
	 * Returns count of deleted rows.
	 */
	async cleanup(): Promise<number> {
		const r = await this.db
			.delete(blockedNumbers)
			.where(and(sql`${blockedNumbers.expiresAt} IS NOT NULL`, lt(blockedNumbers.expiresAt, sql`datetime('now')`)))
			.returning({ whatsapp: blockedNumbers.whatsapp });
		// Bust cache for anything we deleted so they're treated as unblocked immediately.
		for (const row of r) this.cacheBust(row.whatsapp);
		return r.length;
	}

	/** Drops every cached decision. Useful in tests or after a bulk admin op. */
	clearCache(): void {
		this.cache.clear();
	}

	private cacheGet(whatsapp: string): boolean | null {
		if (this.cacheTtlMs === 0) return null;
		const hit = this.cache.get(whatsapp);
		if (!hit) return null;
		if (Date.now() > hit.expiresAt) {
			this.cache.delete(whatsapp);
			return null;
		}
		return hit.blocked;
	}

	private cachePut(whatsapp: string, blocked: boolean): void {
		if (this.cacheTtlMs === 0) return;
		this.cache.set(whatsapp, { blocked, expiresAt: Date.now() + this.cacheTtlMs });
	}

	private cacheBust(whatsapp: string): void {
		this.cache.delete(whatsapp);
	}
}
