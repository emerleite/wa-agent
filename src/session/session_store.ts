/**
 * Per-user AI thread state, keyed by WhatsApp number.
 *
 * From v0.2 onward: backed by Drizzle ORM.
 */
import { eq, desc } from 'drizzle-orm';
import type { DB } from '../db/client.js';
import { sessions, type Session } from '../db/schema/sessions.js';

export interface SessionStoreOptions {
	db: DB;
}

export class SessionStore {
	readonly db: DB;

	constructor({ db }: SessionStoreOptions) {
		if (!db) throw new Error('SessionStore: db required');
		this.db = db;
	}

	async get(whatsapp: string): Promise<Session | null> {
		const r = await this.db
			.select()
			.from(sessions)
			.where(eq(sessions.whatsapp, whatsapp))
			.orderBy(desc(sessions.createdAt))
			.limit(1);
		return r[0] ?? null;
	}

	async set(whatsapp: string, { threadId }: { threadId: string }): Promise<boolean> {
		await this.db
			.insert(sessions)
			.values({ whatsapp, threadId })
			.onConflictDoUpdate({
				target: sessions.whatsapp,
				set: { threadId, updatedAt: new Date().toISOString() },
			});
		return true;
	}

	async clear(whatsapp: string): Promise<void> {
		await this.db.delete(sessions).where(eq(sessions.whatsapp, whatsapp));
	}
}
