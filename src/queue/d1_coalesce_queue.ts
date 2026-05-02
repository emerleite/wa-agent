/**
 * D1-backed message-coalescing queue.
 *
 * Why this exists: WhatsApp users often type in bursts ("hi", "i have", "a question…"),
 * and you want to feed *one* combined turn to the LLM, not three. Cloudflare Queues
 * have no per-key debounce and Durable Objects add complexity. This implements
 * **per-user debounce + coalesce** using only D1.
 */
import type { InboundEnvelope } from '../types.js';

export interface D1QueueOptions {
	db: D1Database;
	table?: string;
	debounceSeconds?: number;
	maxAttempts?: number;
	staleMinutes?: number;
	maxPerInvocation?: number;
	retryDelaySeconds?: number;
	cleanupAfterDays?: number;
}

export interface QueueRow {
	id: number;
	message_id: string;
	whatsapp: string;
	payload: string;
	status: 'pending' | 'processing' | 'done' | 'failed';
	attempts: number;
	scheduled_at: string;
	created_at: string;
	started_at: string | null;
	completed_at: string | null;
	error_message: string | null;
}

export interface BatchInfo {
	envelope: InboundEnvelope;
	rows: QueueRow[];
	combinedText: string;
	whatsapp: string;
}

export type BatchHandler = (info: BatchInfo) => Promise<void>;

export class D1CoalesceQueue {
	readonly db: D1Database;
	readonly table: string;
	readonly debounceSeconds: number;
	readonly maxAttempts: number;
	readonly staleMinutes: number;
	readonly maxPerInvocation: number;
	readonly retryDelaySeconds: number;
	readonly cleanupAfterDays: number;

	constructor({
		db,
		table = 'message_queue',
		debounceSeconds = 3,
		maxAttempts = 3,
		staleMinutes = 5,
		maxPerInvocation = 50,
		retryDelaySeconds = 30,
		cleanupAfterDays = 7,
	}: D1QueueOptions) {
		if (!db) throw new Error('D1CoalesceQueue: db required');
		this.db = db;
		this.table = table;
		this.debounceSeconds = debounceSeconds;
		this.maxAttempts = maxAttempts;
		this.staleMinutes = staleMinutes;
		this.maxPerInvocation = maxPerInvocation;
		this.retryDelaySeconds = retryDelaySeconds;
		this.cleanupAfterDays = cleanupAfterDays;
	}

	async enqueue(envelope: InboundEnvelope): Promise<boolean> {
		const message = envelope?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
		if (!message) return false;

		const wamid = message.id;
		const whatsapp = message.from;
		const payload = JSON.stringify(envelope);

		const ins = await this.db
			.prepare(
				`INSERT OR IGNORE INTO ${this.table} (message_id, whatsapp, payload, scheduled_at)
				 VALUES (?, ?, ?, datetime('now', '+${this.debounceSeconds} seconds'))`
			)
			.bind(wamid, whatsapp, payload)
			.run();

		if (ins.meta.changes === 0) return false;

		await this.db
			.prepare(
				`UPDATE ${this.table}
				 SET scheduled_at = datetime('now', '+${this.debounceSeconds} seconds')
				 WHERE whatsapp = ? AND status = 'pending'`
			)
			.bind(whatsapp)
			.run();

		return true;
	}

	async processAll(handler: BatchHandler): Promise<number> {
		await this.recoverStale();
		let processed = 0;
		while (await this.processNextBatch(handler)) {
			processed++;
			if (processed >= this.maxPerInvocation) break;
		}
		return processed;
	}

	async processNextBatch(handler: BatchHandler): Promise<boolean> {
		const rows = await this.claimBatch();
		if (rows.length === 0) return false;

		const lastRow = rows[rows.length - 1]!;
		const ids = rows.map((r) => r.id);
		const lastEnvelope = JSON.parse(lastRow.payload) as InboundEnvelope;
		const combinedText = combineText(rows);

		try {
			await handler({ envelope: lastEnvelope, rows, combinedText, whatsapp: rows[0]!.whatsapp });
			await this.completeBatch(ids);
		} catch (e) {
			await this.failBatch(ids, e instanceof Error ? e.message : String(e));
		}
		return true;
	}

	async claimBatch(): Promise<QueueRow[]> {
		const next = await this.db
			.prepare(
				`SELECT whatsapp FROM ${this.table}
				 WHERE status = 'pending' AND scheduled_at <= datetime('now')
				 ORDER BY created_at ASC
				 LIMIT 1`
			)
			.first<{ whatsapp: string }>();
		if (!next) return [];

		// Atomic claim: UPDATE…RETURNING ensures only the invocation that
		// flips a row from pending→processing receives it. The previous
		// implementation used db.batch([UPDATE, SELECT WHERE started_at >= now-3s])
		// — under concurrent processAll() (e.g. webhook waitUntil + every-minute
		// cron) the SELECT could return rows the other invocation just claimed,
		// so the same message would be handed to two handlers and sent twice.
		const result = await this.db
			.prepare(
				`UPDATE ${this.table}
				 SET status = 'processing', attempts = attempts + 1, started_at = datetime('now')
				 WHERE whatsapp = ? AND status = 'pending' AND scheduled_at <= datetime('now')
				 RETURNING *`
			)
			.bind(next.whatsapp)
			.all<QueueRow>();

		const rows = result.results ?? [];
		// RETURNING doesn't guarantee row order; sort by created_at so the
		// caller sees the burst in send order.
		rows.sort((a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0));
		return rows;
	}

	async completeBatch(ids: number[]): Promise<void> {
		if (!ids.length) return;
		await this.db.batch(
			ids.map((id) =>
				this.db.prepare(`UPDATE ${this.table} SET status = 'done', completed_at = datetime('now') WHERE id = ?`).bind(id)
			)
		);
	}

	async failBatch(ids: number[], errorMessage: string): Promise<void> {
		if (!ids.length) return;
		await this.db.batch(
			ids.map((id) =>
				this.db
					.prepare(
						`UPDATE ${this.table}
						 SET status = CASE WHEN attempts >= ? THEN 'failed' ELSE 'pending' END,
							 error_message = ?,
							 started_at = NULL,
							 scheduled_at = datetime('now', '+${this.retryDelaySeconds} seconds')
						 WHERE id = ?`
					)
					.bind(this.maxAttempts, errorMessage, id)
			)
		);
	}

	async recoverStale(): Promise<void> {
		await this.db
			.prepare(
				`UPDATE ${this.table}
				 SET status = 'pending', started_at = NULL
				 WHERE status = 'processing'
				 AND started_at < datetime('now', '-${this.staleMinutes} minutes')`
			)
			.run();
	}

	async cleanup(): Promise<void> {
		await this.db
			.prepare(`DELETE FROM ${this.table} WHERE status = 'done' AND completed_at < datetime('now', '-${this.cleanupAfterDays} days')`)
			.run();
	}
}

/**
 * Combine the text bodies of multiple buffered messages into one prompt-friendly string.
 * Audio / interactive messages contribute placeholders/titles so the LLM has context.
 */
export function combineText(rows: QueueRow[]): string {
	const parts: string[] = [];
	for (const row of rows) {
		const env = JSON.parse(row.payload) as InboundEnvelope;
		const m = env.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
		if (!m) continue;
		if (m.type === 'text' && m.text?.body) parts.push(m.text.body);
		else if (m.type === 'audio') parts.push('[audio message]');
		else if (m.type === 'interactive') {
			const t = m.interactive?.button_reply?.title || m.interactive?.list_reply?.title || '';
			if (t) parts.push(t);
		}
	}
	return parts.join('\n');
}
