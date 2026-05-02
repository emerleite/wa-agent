/**
 * Per-user persistent state (e.g., AI thread_id) keyed by WhatsApp number.
 */
export interface SessionStoreOptions {
	db: D1Database;
	table?: string;
}

export interface SessionRow {
	id: number;
	thread_id: string | null;
	whatsapp: string;
	created_at: string;
	updated_at: string;
	[k: string]: unknown;
}

export class SessionStore {
	readonly db: D1Database;
	readonly table: string;

	constructor({ db, table = 'sessions' }: SessionStoreOptions) {
		if (!db) throw new Error('SessionStore: db required');
		this.db = db;
		this.table = table;
	}

	async get(whatsapp: string): Promise<SessionRow | null> {
		return await this.db
			.prepare(`SELECT * FROM ${this.table} WHERE whatsapp = ? ORDER BY created_at DESC LIMIT 1`)
			.bind(whatsapp)
			.first<SessionRow>();
	}

	async set(whatsapp: string, { threadId }: { threadId: string }): Promise<boolean> {
		const r = await this.db
			.prepare(`INSERT OR REPLACE INTO ${this.table} (thread_id, whatsapp) VALUES (?, ?)`)
			.bind(threadId, whatsapp)
			.run();
		return r.success;
	}

	async clear(whatsapp: string): Promise<void> {
		await this.db.prepare(`DELETE FROM ${this.table} WHERE whatsapp = ?`).bind(whatsapp).run();
	}
}
