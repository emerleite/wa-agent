/**
 * Tracks Meta's customer service window so the agent knows when it can send
 * a free-form (non-template) message.
 */
import type { WindowType } from '../types.js';

export interface MessageWindowOptions {
	db: D1Database;
	table?: string;
	freeWindowExpr?: string;
	paidWindowExpr?: string;
}

export interface WindowStatus {
	inWindow: boolean;
	type: WindowType | null;
}

export interface OpenWindowRow {
	whatsapp: string;
	window_type: WindowType;
	end_time: string;
}

export class MessageWindow {
	readonly db: D1Database;
	readonly table: string;
	readonly freeWindowExpr: string;
	readonly paidWindowExpr: string;

	constructor({
		db,
		table = 'message_windows',
		freeWindowExpr = "datetime('now', '+71 hours', '+30 minutes')",
		paidWindowExpr = "datetime('now', '+23 hours', '+30 minutes')",
	}: MessageWindowOptions) {
		if (!db) throw new Error('MessageWindow: db required');
		this.db = db;
		this.table = table;
		this.freeWindowExpr = freeWindowExpr;
		this.paidWindowExpr = paidWindowExpr;
	}

	async start(whatsapp: string, type: WindowType = 'paid'): Promise<void> {
		const expr = type === 'free' ? this.freeWindowExpr : this.paidWindowExpr;
		await this.db
			.prepare(
				`INSERT INTO ${this.table} (whatsapp, window_type, end_time)
				 VALUES (?, ?, ${expr})
				 ON CONFLICT (whatsapp) DO UPDATE SET
				   window_type = excluded.window_type,
				   start_time = datetime('now'),
				   end_time = ${expr}`
			)
			.bind(whatsapp, type)
			.run();
	}

	async status(whatsapp: string): Promise<WindowStatus> {
		const row = await this.db
			.prepare(
				`SELECT window_type, datetime('now') < end_time AS within
				 FROM ${this.table} WHERE whatsapp = ?`
			)
			.bind(whatsapp)
			.first<{ window_type: WindowType; within: number }>();
		if (!row) return { inWindow: false, type: null };
		return { inWindow: !!row.within, type: row.window_type };
	}

	async listOpen({ limit = 5000 }: { limit?: number } = {}): Promise<OpenWindowRow[]> {
		const r = await this.db
			.prepare(`SELECT whatsapp, window_type, end_time FROM ${this.table} WHERE datetime('now') < end_time LIMIT ?`)
			.bind(limit)
			.all<OpenWindowRow>();
		return r.results ?? [];
	}
}
