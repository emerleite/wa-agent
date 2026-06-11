/**
 * D1-backed message-coalescing queue.
 *
 * Why this exists: WhatsApp users often type in bursts ("hi", "i have", "a question…"),
 * and you want to feed *one* combined turn to the LLM, not three. Cloudflare Queues
 * have no per-key debounce and Durable Objects add complexity. This implements
 * **per-user debounce + coalesce** using only D1.
 *
 * From v0.2 onward: backed by Drizzle ORM.
 */
import { and, asc, eq, lte, lt, sql } from 'drizzle-orm';
import type { DB } from '../db/client.js';
import { messageQueue } from '../db/schema/message_queue.js';
import type { InboundEnvelope } from '../types.js';

export interface D1QueueOptions {
	db: DB;
	debounceSeconds?: number;
	maxAttempts?: number;
	staleMinutes?: number;
	maxPerInvocation?: number;
	retryDelaySeconds?: number;
	cleanupAfterDays?: number;
	/**
	 * Multi-tenant scoping (v0.6+). When set, `enqueue` writes the tenantId
	 * to the row and `claimBatch` only picks rows for THIS tenant. Single-tenant
	 * deployments leave this unset (or null) — the IS NULL filter preserves
	 * pre-v0.6 behavior bit-for-bit. Set this to the same string `Agent` uses
	 * for `tenantId` so the registry's per-tenant Agents stay isolated.
	 */
	tenantId?: string | null;
}

export interface QueueRow {
	id: number;
	message_id: string | null;
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

/**
 * Drizzle row → public QueueRow (snake_case for backwards compatibility).
 * Kept stable so consumers reading `rows[].message_id` / `rows[].created_at`
 * in their BatchHandler don't break across the Drizzle migration.
 */
function toQueueRow(r: typeof messageQueue.$inferSelect): QueueRow {
	return {
		id: r.id,
		message_id: r.messageId,
		whatsapp: r.whatsapp,
		payload: r.payload,
		status: r.status,
		attempts: r.attempts,
		scheduled_at: r.scheduledAt,
		created_at: r.createdAt,
		started_at: r.startedAt,
		completed_at: r.completedAt,
		error_message: r.errorMessage,
	};
}

export class D1CoalesceQueue {
	readonly db: DB;
	readonly debounceSeconds: number;
	readonly maxAttempts: number;
	readonly staleMinutes: number;
	readonly maxPerInvocation: number;
	readonly retryDelaySeconds: number;
	readonly cleanupAfterDays: number;
	readonly tenantId: string | null;

	constructor({
		db,
		debounceSeconds = 3,
		maxAttempts = 3,
		staleMinutes = 5,
		maxPerInvocation = 50,
		retryDelaySeconds = 30,
		cleanupAfterDays = 7,
		tenantId = null,
	}: D1QueueOptions) {
		if (!db) throw new Error('D1CoalesceQueue: db required');
		this.db = db;
		this.debounceSeconds = debounceSeconds;
		this.maxAttempts = maxAttempts;
		this.staleMinutes = staleMinutes;
		this.maxPerInvocation = maxPerInvocation;
		this.retryDelaySeconds = retryDelaySeconds;
		this.cleanupAfterDays = cleanupAfterDays;
		this.tenantId = tenantId;
	}

	async enqueue(envelope: InboundEnvelope): Promise<boolean> {
		const message = envelope?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
		if (!message) return false;

		const wamid = message.id;
		const whatsapp = message.from;
		const payload = JSON.stringify(envelope);
		const debounceExpr = sql.raw(`(datetime('now', '+${this.debounceSeconds} seconds'))`);

		const ins = await this.db
			.insert(messageQueue)
			.values({ messageId: wamid, whatsapp, payload, scheduledAt: debounceExpr, tenantId: this.tenantId })
			.onConflictDoNothing({ target: messageQueue.messageId })
			.returning({ id: messageQueue.id });

		if (ins.length === 0) return false;

		// Push the debounce forward for every still-pending row on this user so the
		// whole burst settles to the same fire time. Scope to this tenant —
		// multi-tenant deployments don't want one tenant's burst to slide
		// another tenant's queue forward.
		await this.db
			.update(messageQueue)
			.set({ scheduledAt: debounceExpr })
			.where(
				and(
					eq(messageQueue.whatsapp, whatsapp),
					eq(messageQueue.status, 'pending'),
					this.tenantScopeFilter(),
				),
			);

		return true;
	}

	/**
	 * SQL fragment that scopes a query to this queue's tenantId. Single-tenant
	 * deployments (tenantId === null) filter by `tenant_id IS NULL`; tenant
	 * deployments filter by `tenant_id = ?`. Centralized so enqueue, claim,
	 * recover, and cleanup stay consistent.
	 */
	private tenantScopeFilter() {
		return this.tenantId === null
			? sql`${messageQueue.tenantId} IS NULL`
			: eq(messageQueue.tenantId, this.tenantId);
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
		// Pick the user whose oldest pending row is due — scoped to this
		// tenant so multi-tenant deployments don't dispatch one tenant's
		// rows through another tenant's Agent.
		const next = await this.db
			.select({ whatsapp: messageQueue.whatsapp })
			.from(messageQueue)
			.where(
				and(
					eq(messageQueue.status, 'pending'),
					lte(messageQueue.scheduledAt, sql`(datetime('now'))`),
					this.tenantScopeFilter(),
				),
			)
			.orderBy(asc(messageQueue.createdAt))
			.limit(1);
		if (!next[0]) return [];

		// Atomic claim: UPDATE…RETURNING ensures only the invocation that flips a
		// row from pending→processing receives it. Without RETURNING, two
		// concurrent processAll() runs (e.g. webhook waitUntil + every-minute
		// cron) could each SELECT the same rows and double-dispatch.
		const claimed = await this.db
			.update(messageQueue)
			.set({
				status: 'processing',
				attempts: sql`${messageQueue.attempts} + 1`,
				startedAt: sql`(datetime('now'))`,
			})
			.where(
				and(
					eq(messageQueue.whatsapp, next[0].whatsapp),
					eq(messageQueue.status, 'pending'),
					lte(messageQueue.scheduledAt, sql`(datetime('now'))`),
					this.tenantScopeFilter(),
				)
			)
			.returning();

		// RETURNING doesn't guarantee row order; sort by created_at so the caller
		// sees the burst in send order.
		const rows = claimed.map(toQueueRow);
		rows.sort((a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0));
		return rows;
	}

	async completeBatch(ids: number[]): Promise<void> {
		if (!ids.length) return;
		await Promise.all(
			ids.map((id) =>
				this.db
					.update(messageQueue)
					.set({ status: 'done', completedAt: sql`(datetime('now'))` })
					.where(eq(messageQueue.id, id))
			)
		);
	}

	async failBatch(ids: number[], errorMessage: string): Promise<void> {
		if (!ids.length) return;
		const retryExpr = sql.raw(`(datetime('now', '+${this.retryDelaySeconds} seconds'))`);
		const maxAttempts = this.maxAttempts;
		await Promise.all(
			ids.map((id) =>
				this.db
					.update(messageQueue)
					.set({
						status: sql`CASE WHEN ${messageQueue.attempts} >= ${maxAttempts} THEN 'failed' ELSE 'pending' END`,
						errorMessage,
						startedAt: null,
						scheduledAt: retryExpr,
					})
					.where(eq(messageQueue.id, id))
			)
		);
	}

	async recoverStale(): Promise<void> {
		await this.db
			.update(messageQueue)
			.set({ status: 'pending', startedAt: null })
			.where(
				and(
					eq(messageQueue.status, 'processing'),
					lt(messageQueue.startedAt, sql.raw(`(datetime('now', '-${this.staleMinutes} minutes'))`)),
					this.tenantScopeFilter(),
				)
			);
	}

	async cleanup(): Promise<void> {
		await this.db
			.delete(messageQueue)
			.where(
				and(
					eq(messageQueue.status, 'done'),
					lt(messageQueue.completedAt, sql.raw(`(datetime('now', '-${this.cleanupAfterDays} days'))`)),
					this.tenantScopeFilter(),
				)
			);
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
