/**
 * Inbound + outbound message audit log.
 */
export interface MessageLogOptions {
	db: D1Database;
	table?: string;
}

export interface MessageRow {
	id: number;
	wamid: string;
	whatsapp: string;
	thread_id: string | null;
	type: string;
	payload: string;
	body: string | null;
	response: string | null;
	summary: string | null;
	feedback: string | null;
	created_at: string;
	updated_at: string;
}

export class MessageLog {
	readonly db: D1Database;
	readonly table: string;

	constructor({ db, table = 'messages' }: MessageLogOptions) {
		if (!db) throw new Error('MessageLog: db required');
		this.db = db;
		this.table = table;
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
			const r = await this.db
				.prepare(`INSERT INTO ${this.table} (wamid, whatsapp, type, payload) VALUES (?, ?, ?, ?)`)
				.bind(wamid, whatsapp, type, typeof payload === 'string' ? payload : JSON.stringify(payload))
				.run();
			return r.success && r.meta.changes === 1;
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
			.prepare(`UPDATE ${this.table} SET body = ?, response = ?, summary = ? WHERE wamid = ?`)
			.bind(body, response, summary, wamid)
			.run();
		return r.success && r.meta.changes === 1;
	}

	async byWamid(wamid: string): Promise<MessageRow | null> {
		return await this.db.prepare(`SELECT * FROM ${this.table} WHERE wamid = ? LIMIT 1`).bind(wamid).first<MessageRow>();
	}

	async totalForUser(whatsapp: string): Promise<number> {
		const row = await this.db.prepare(`SELECT COUNT(*) as total FROM ${this.table} WHERE whatsapp = ?`).bind(whatsapp).first<{ total: number }>();
		return row?.total ?? 0;
	}
}
