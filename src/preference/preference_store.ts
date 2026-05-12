/**
 * Per-user, per-key preferences (string values).
 *
 * Common use cases:
 *  - Delivery mode: "text" / "audio" / "both"
 *  - Language: "en" / "pt" / "es"
 *  - Notification frequency: "daily" / "weekly" / "never"
 *  - Content tier preference: "short" / "long"
 *
 * Why a separate store (not extra columns on LeadStore): a bot with five
 * preferences shouldn't need five ALTER TABLEs. The PRIMARY KEY (whatsapp, key)
 * lets you add new preference types without migrations.
 *
 * Values are TEXT; serialize JSON yourself if you need structured prefs.
 *
 * From v0.2 onward: backed by Drizzle ORM.
 */
import { and, eq, sql } from 'drizzle-orm';
import type { DB } from '../db/client.js';
import { userPreferences } from '../db/schema/preferences.js';

export interface PreferenceStoreOptions {
	db: DB;
}

export interface SetOptions {
	/** If provided, reject the call when `value` is not in this list. */
	allowed?: readonly string[];
}

export class PreferenceStore {
	readonly db: DB;

	constructor({ db }: PreferenceStoreOptions) {
		if (!db) throw new Error('PreferenceStore: db required');
		this.db = db;
	}

	/**
	 * Read a preference. Returns `defaultValue` if the user has no row for `key`.
	 */
	async get(whatsapp: string, key: string, defaultValue: string | null = null): Promise<string | null> {
		try {
			const r = await this.db
				.select({ value: userPreferences.value })
				.from(userPreferences)
				.where(and(eq(userPreferences.whatsapp, whatsapp), eq(userPreferences.key, key)))
				.limit(1);
			return r[0]?.value ?? defaultValue;
		} catch (e) {
			console.error('[PreferenceStore] get:', e instanceof Error ? e.message : e);
			return defaultValue;
		}
	}

	/**
	 * Upsert a preference. If `allowed` is supplied, rejects values not in it
	 * (returns false without writing).
	 */
	async set(whatsapp: string, key: string, value: string, { allowed }: SetOptions = {}): Promise<boolean> {
		if (allowed && !allowed.includes(value)) return false;
		try {
			await this.db
				.insert(userPreferences)
				.values({ whatsapp, key, value })
				.onConflictDoUpdate({
					target: [userPreferences.whatsapp, userPreferences.key],
					set: { value, updatedAt: sql`(datetime('now'))` },
				});
			return true;
		} catch (e) {
			console.error('[PreferenceStore] set:', e instanceof Error ? e.message : e);
			return false;
		}
	}

	async clear(whatsapp: string, key: string): Promise<void> {
		await this.db.delete(userPreferences).where(and(eq(userPreferences.whatsapp, whatsapp), eq(userPreferences.key, key)));
	}

	/**
	 * Fetch all preferences for one user as a key→value map.
	 * Missing keys are simply absent — supply your own defaults.
	 */
	async getAll(whatsapp: string): Promise<Record<string, string>> {
		const rows = await this.db
			.select({ key: userPreferences.key, value: userPreferences.value })
			.from(userPreferences)
			.where(eq(userPreferences.whatsapp, whatsapp));
		const out: Record<string, string> = {};
		for (const row of rows) out[row.key] = row.value;
		return out;
	}
}

/**
 * Define a typed preference for ergonomic call sites.
 *
 *   const deliveryMode = definePreference('delivery_mode', 'both', ['text', 'audio', 'both'] as const);
 *   await deliveryMode.get(prefs, '5551');           // 'both' (default)
 *   await deliveryMode.set(prefs, '5551', 'audio');  // validates
 */
export function definePreference<T extends string>(key: string, defaultValue: T, allowed?: readonly T[]) {
	return {
		key,
		defaultValue,
		allowed,
		async get(store: PreferenceStore, whatsapp: string): Promise<T> {
			const v = await store.get(whatsapp, key, defaultValue);
			return (v ?? defaultValue) as T;
		},
		async set(store: PreferenceStore, whatsapp: string, value: T): Promise<boolean> {
			return await store.set(whatsapp, key, value, allowed ? { allowed: allowed as readonly string[] } : {});
		},
	};
}
