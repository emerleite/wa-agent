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
 * Default schema (migration 008_preferences.sql):
 *   user_preferences(whatsapp, key, value, updated_at)
 *
 * Values are TEXT; serialize JSON yourself if you need structured prefs.
 */
export interface PreferenceStoreOptions {
	db: D1Database;
	table?: string;
}

export interface SetOptions {
	/** If provided, reject the call when `value` is not in this list. */
	allowed?: readonly string[];
}

export class PreferenceStore {
	readonly db: D1Database;
	readonly table: string;

	constructor({ db, table = 'user_preferences' }: PreferenceStoreOptions) {
		if (!db) throw new Error('PreferenceStore: db required');
		this.db = db;
		this.table = table;
	}

	/**
	 * Read a preference. Returns `defaultValue` if the user has no row for `key`.
	 */
	async get(whatsapp: string, key: string, defaultValue: string | null = null): Promise<string | null> {
		try {
			const row = await this.db
				.prepare(`SELECT value FROM ${this.table} WHERE whatsapp = ? AND key = ?`)
				.bind(whatsapp, key)
				.first<{ value: string }>();
			return row?.value ?? defaultValue;
		} catch (e) {
			console.error('[PreferenceStore] get:', e instanceof Error ? e.message : e);
			return defaultValue;
		}
	}

	/**
	 * Upsert a preference. If `allowed` is supplied, rejects values not in it
	 * (returns false without writing). Empty/null values clear the row.
	 */
	async set(whatsapp: string, key: string, value: string, { allowed }: SetOptions = {}): Promise<boolean> {
		if (allowed && !allowed.includes(value)) return false;
		try {
			await this.db
				.prepare(
					`INSERT INTO ${this.table} (whatsapp, key, value) VALUES (?, ?, ?)
					 ON CONFLICT(whatsapp, key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`
				)
				.bind(whatsapp, key, value)
				.run();
			return true;
		} catch (e) {
			console.error('[PreferenceStore] set:', e instanceof Error ? e.message : e);
			return false;
		}
	}

	async clear(whatsapp: string, key: string): Promise<void> {
		await this.db.prepare(`DELETE FROM ${this.table} WHERE whatsapp = ? AND key = ?`).bind(whatsapp, key).run();
	}

	/**
	 * Fetch all preferences for one user as a key→value map.
	 * Missing keys are simply absent — supply your own defaults.
	 */
	async getAll(whatsapp: string): Promise<Record<string, string>> {
		const r = await this.db.prepare(`SELECT key, value FROM ${this.table} WHERE whatsapp = ?`).bind(whatsapp).all<{ key: string; value: string }>();
		const out: Record<string, string> = {};
		for (const row of r.results ?? []) out[row.key] = row.value;
		return out;
	}
}

/**
 * Define a typed preference for ergonomic call sites.
 *
 *   const deliveryMode = definePreference('delivery_mode', 'both', ['text', 'audio', 'both'] as const);
 *   await deliveryMode.get(prefs, '5551');           // 'both' (default)
 *   await deliveryMode.set(prefs, '5551', 'audio');  // validates
 *
 * The returned object captures `key`, `default`, and `allowed` so call sites
 * stay declarative and the allowed list lives next to the preference name.
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
