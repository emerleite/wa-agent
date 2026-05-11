/**
 * Inbound + outbound message audit log.
 *
 * From v0.2 onward: backed by Drizzle ORM.
 */
import { eq, sql } from 'drizzle-orm';
import type { DB } from '../db/client.js';
import { messages, type Message } from '../db/schema/messages.js';

export interface MessageLogOptions {
	db: DB;
}

export class MessageLog {
	readonly db: DB;

	constructor({ db }: MessageLogOptions) {
		if (!db) throw new Error('MessageLog: db required');
		this.db = db;
	}

	async logInbound({
		wamid,
		whatsapp,
		type,
		payload,
	}: {
		wamid: string;
		whatsapp: string;
		type: string;
		payload: unknown;
	}): Promise<boolean> {
		try {
			await this.db.insert(messages).values({
				wamid,
				whatsapp,
				type,
				payload: typeof payload === 'string' ? payload : JSON.stringify(payload),
			});
			return true;
		} catch (e) {
			console.error('[MessageLog] logInbound:', e instanceof Error ? e.message : e);
			return false;
		}
	}

	async updateAnswer(
		wamid: string,
		{ body, response, summary }: { body: string; response: string | null; summary: string | null }
	): Promise<boolean> {
		const r = await this.db
			.update(messages)
			.set({ body, response, summary })
			.where(eq(messages.wamid, wamid))
			.returning({ id: messages.id });
		return r.length === 1;
	}

	async byWamid(wamid: string): Promise<Message | null> {
		const r = await this.db.select().from(messages).where(eq(messages.wamid, wamid)).limit(1);
		return r[0] ?? null;
	}

	async totalForUser(whatsapp: string): Promise<number> {
		const r = await this.db
			.select({ total: sql<number>`count(*)`.as('total') })
			.from(messages)
			.where(eq(messages.whatsapp, whatsapp));
		return r[0]?.total ?? 0;
	}
}
