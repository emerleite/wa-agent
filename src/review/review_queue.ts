/**
 * Queue-and-approve workflow for `assisted` mode (v0.8).
 *
 * v0.5 introduced `mode: 'assisted'` — every AI turn records an
 * `assisted_review` escalation. But the reply still went out immediately,
 * so the "review" happened AFTER the fact. v0.8 closes the loop: when
 * `Agent.reviewQueue` is set + `mode === 'assisted'`, `reply.ai()`
 * enqueues a `pending` row INSTEAD of sending. A human dashboard reads
 * from this table; approving dispatches the text (possibly edited) via
 * the right tenant's Agent. Rejecting silently drops.
 *
 * Wiring inside the framework:
 *
 *   const reviewQueue = new AgentReviewQueue({ db: env.DB });
 *   agent = new Agent({ mode: 'assisted', reviewQueue });
 *
 * The Agent intercepts the AI answer + threadId + traceId and calls
 * `reviewQueue.enqueue(...)`. Per-tenant dispatch is done by the cron
 * helper `MultiTenantAgentRegistry.dispatchApprovedReviews`.
 *
 * Apps with their own richer schema follow the same column-map pattern
 * as `EscalationStore` / `ConsentStore`:
 *
 *   new AgentReviewQueue({
 *     db: env.DB,
 *     tableName: 'agent_review_queue',
 *     columnMap: { aiText: 'draft', editedText: 'final' },
 *     omitColumns: ['whatsapp'],
 *     allowedExtraColumns: ['patient_id'],
 *   });
 */
import { sql } from 'drizzle-orm';
import { normalizeDb, type DB } from '../db/client.js';
import type { PendingReviewRow } from '../db/schema/pending_reviews.js';

export type ReviewStatus = 'pending' | 'approved' | 'sent' | 'rejected';

export type ReviewField =
	| 'id'
	| 'whatsapp'
	| 'aiText'
	| 'editedText'
	| 'status'
	| 'wamid'
	| 'traceId'
	| 'tenantId'
	| 'threadId'
	| 'createdAt'
	| 'approvedAt'
	| 'approvedBy'
	| 'sentAt';

export const DEFAULT_REVIEW_COLUMNS: Readonly<Record<ReviewField, string>> = Object.freeze({
	id: 'id',
	whatsapp: 'whatsapp',
	aiText: 'ai_text',
	editedText: 'edited_text',
	status: 'status',
	wamid: 'wamid',
	traceId: 'trace_id',
	tenantId: 'tenant_id',
	threadId: 'thread_id',
	createdAt: 'created_at',
	approvedAt: 'approved_at',
	approvedBy: 'approved_by',
	sentAt: 'sent_at',
});

const SAFE_IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

export interface AgentReviewQueueOptions {
	/**
	 * D1 binding OR a pre-built Drizzle client (any schema). v0.7+:
	 * normalized internally.
	 */
	db: D1Database | DB;
	/** Physical table name. Default `'pending_reviews'`. */
	tableName?: string;
	columnMap?: Partial<Record<ReviewField, string>>;
	omitColumns?: ReadonlyArray<ReviewField>;
	allowedExtraColumns?: ReadonlyArray<string>;
}

export interface EnqueueReviewArgs {
	whatsapp?: string | null;
	aiText: string;
	wamid?: string | null;
	traceId?: string | null;
	tenantId?: string | null;
	threadId?: string | null;
	extraColumns?: Record<string, string | number | null>;
}

export interface ApproveReviewArgs {
	approvedBy?: string | null;
	/** Override the original AI text. NULL means "send the original". */
	editedText?: string | null;
}

export interface ListReviewsOptions {
	status?: ReviewStatus;
	tenantId?: string;
	whatsapp?: string;
	limit?: number;
}

export type ReviewRow = PendingReviewRow;

export class AgentReviewQueue {
	readonly db: DB;
	readonly tableName: string;
	readonly columns: Readonly<Record<ReviewField, string>>;
	readonly omitColumns: ReadonlySet<ReviewField>;
	readonly allowedExtraColumns: ReadonlySet<string>;

	constructor({
		db,
		tableName = 'pending_reviews',
		columnMap,
		omitColumns,
		allowedExtraColumns,
	}: AgentReviewQueueOptions) {
		if (!db) throw new Error('AgentReviewQueue: db required');
		if (!SAFE_IDENT.test(tableName)) {
			throw new Error('AgentReviewQueue: tableName must be a bare SQL identifier');
		}
		const merged: Record<ReviewField, string> = { ...DEFAULT_REVIEW_COLUMNS };
		if (columnMap) {
			for (const [k, v] of Object.entries(columnMap) as Array<[ReviewField, string | undefined]>) {
				if (v === undefined) continue;
				if (!SAFE_IDENT.test(v)) {
					throw new Error(`AgentReviewQueue: columnMap.${k} must be a bare SQL identifier`);
				}
				merged[k] = v;
			}
		}
		const extra = new Set<string>();
		if (allowedExtraColumns) {
			for (const name of allowedExtraColumns) {
				if (!SAFE_IDENT.test(name)) {
					throw new Error(`AgentReviewQueue: allowedExtraColumns "${name}" must be a bare SQL identifier`);
				}
				extra.add(name);
			}
		}
		this.db = normalizeDb(db);
		this.tableName = tableName;
		this.columns = Object.freeze(merged);
		this.omitColumns = new Set(omitColumns ?? []);
		this.allowedExtraColumns = extra;
	}

	/**
	 * Insert a new pending review. Returns the generated id. The framework
	 * calls this from `Agent.reply.ai()` when `mode === 'assisted'` + a
	 * `reviewQueue` is configured.
	 */
	async enqueue(args: EnqueueReviewArgs): Promise<string> {
		if (!args.aiText) throw new Error('AgentReviewQueue.enqueue: aiText required');
		if (!this.omitColumns.has('whatsapp') && !args.whatsapp) {
			throw new Error("AgentReviewQueue.enqueue: whatsapp required (or set omitColumns: ['whatsapp'])");
		}
		const id = crypto.randomUUID();
		const c = this.columns;
		const framework: Array<[ReviewField, unknown]> = [
			['id', id],
			['whatsapp', args.whatsapp ?? ''],
			['aiText', args.aiText],
			['status', 'pending' as ReviewStatus],
			['wamid', args.wamid ?? null],
			['traceId', args.traceId ?? null],
			['tenantId', args.tenantId ?? null],
			['threadId', args.threadId ?? null],
		];
		const cols: Array<ReturnType<typeof sql>> = [];
		const vals: Array<unknown> = [];
		for (const [field, value] of framework) {
			if (this.omitColumns.has(field)) continue;
			cols.push(sql.raw(c[field]));
			vals.push(value);
		}
		if (args.extraColumns) {
			for (const [name, value] of Object.entries(args.extraColumns)) {
				if (!this.allowedExtraColumns.has(name)) {
					throw new Error(`AgentReviewQueue.enqueue: extraColumns.${name} is not in allowedExtraColumns`);
				}
				cols.push(sql.raw(name));
				vals.push(value);
			}
		}
		await this.db.run(sql`
			INSERT INTO ${sql.raw(this.tableName)} (${sql.join(cols, sql`, `)})
			VALUES (${sql.join(vals.map((v) => sql`${v}`), sql`, `)})`);
		return id;
	}

	async byId(id: string): Promise<ReviewRow | null> {
		const stmt = sql`
			SELECT ${this.selectList()} FROM ${sql.raw(this.tableName)}
			WHERE ${sql.raw(this.columns.id)} = ${id} LIMIT 1`;
		const rows = await this.db.all<ReviewRow>(stmt);
		return rows[0] ?? null;
	}

	/**
	 * Approve a pending review. Optional `editedText` overrides the AI's
	 * answer on dispatch. Idempotent — re-approving an already-approved row
	 * is a no-op. Returns true if the row transitioned from pending → approved.
	 */
	async approve(id: string, args: ApproveReviewArgs = {}): Promise<boolean> {
		const c = this.columns;
		const rows = await this.db.all<{ id: string }>(sql`
			UPDATE ${sql.raw(this.tableName)}
			SET ${sql.raw(c.status)} = ${'approved' as ReviewStatus},
			    ${sql.raw(c.approvedAt)} = (datetime('now')),
			    ${sql.raw(c.approvedBy)} = ${args.approvedBy ?? null},
			    ${sql.raw(c.editedText)} = ${args.editedText ?? null}
			WHERE ${sql.raw(c.id)} = ${id} AND ${sql.raw(c.status)} = ${'pending' as ReviewStatus}
			RETURNING ${sql.raw(c.id)} AS id`);
		return rows.length > 0;
	}

	/** Reject a pending review. Idempotent. */
	async reject(id: string, args: { rejectedBy?: string | null } = {}): Promise<boolean> {
		const c = this.columns;
		const rows = await this.db.all<{ id: string }>(sql`
			UPDATE ${sql.raw(this.tableName)}
			SET ${sql.raw(c.status)} = ${'rejected' as ReviewStatus},
			    ${sql.raw(c.approvedAt)} = (datetime('now')),
			    ${sql.raw(c.approvedBy)} = ${args.rejectedBy ?? null}
			WHERE ${sql.raw(c.id)} = ${id} AND ${sql.raw(c.status)} = ${'pending' as ReviewStatus}
			RETURNING ${sql.raw(c.id)} AS id`);
		return rows.length > 0;
	}

	/**
	 * Mark a row 'sent' after the WhatsApp dispatch succeeded.
	 * `dispatchApprovedReviews` calls this after `client.sendText` returns.
	 */
	async markSent(id: string): Promise<void> {
		const c = this.columns;
		await this.db.run(sql`
			UPDATE ${sql.raw(this.tableName)}
			SET ${sql.raw(c.status)} = ${'sent' as ReviewStatus},
			    ${sql.raw(c.sentAt)} = (datetime('now'))
			WHERE ${sql.raw(c.id)} = ${id} AND ${sql.raw(c.status)} = ${'approved' as ReviewStatus}`);
	}

	async list({ status, tenantId, whatsapp, limit = 100 }: ListReviewsOptions = {}): Promise<ReviewRow[]> {
		const c = this.columns;
		const filters = [
			status ? sql`${sql.raw(c.status)} = ${status}` : null,
			tenantId ? sql`${sql.raw(c.tenantId)} = ${tenantId}` : null,
			whatsapp ? sql`${sql.raw(c.whatsapp)} = ${whatsapp}` : null,
		].filter((f): f is ReturnType<typeof sql> => f !== null);
		const where = filters.length ? sql` WHERE ${sql.join(filters, sql` AND `)}` : sql``;
		const stmt = sql`
			SELECT ${this.selectList()} FROM ${sql.raw(this.tableName)}${where}
			ORDER BY ${sql.raw(c.createdAt)} DESC LIMIT ${limit}`;
		return await this.db.all<ReviewRow>(stmt);
	}

	/** Number of rows in a given status (default 'pending'), optionally per-tenant. */
	async countByStatus(status: ReviewStatus = 'pending', tenantId?: string): Promise<number> {
		const c = this.columns;
		const filters = [sql`${sql.raw(c.status)} = ${status}`];
		if (tenantId) filters.push(sql`${sql.raw(c.tenantId)} = ${tenantId}`);
		const rows = await this.db.all<{ n: number }>(sql`
			SELECT COUNT(*) AS n FROM ${sql.raw(this.tableName)}
			WHERE ${sql.join(filters, sql` AND `)}`);
		return rows[0]?.n ?? 0;
	}

	private selectList(): ReturnType<typeof sql> {
		const c = this.columns;
		const fields: Array<[ReviewField, string]> = [
			['id', 'id'],
			['whatsapp', 'whatsapp'],
			['aiText', '"aiText"'],
			['editedText', '"editedText"'],
			['status', 'status'],
			['wamid', 'wamid'],
			['traceId', '"traceId"'],
			['tenantId', '"tenantId"'],
			['threadId', '"threadId"'],
			['createdAt', '"createdAt"'],
			['approvedAt', '"approvedAt"'],
			['approvedBy', '"approvedBy"'],
			['sentAt', '"sentAt"'],
		];
		const fragments = fields.map(([field, alias]) => {
			if (this.omitColumns.has(field)) {
				const isText =
					field === 'id' ||
					field === 'whatsapp' ||
					field === 'aiText' ||
					field === 'status' ||
					field === 'createdAt';
				return sql`${isText ? sql`''` : sql`NULL`} AS ${sql.raw(alias)}`;
			}
			return sql`${sql.raw(c[field])} AS ${sql.raw(alias)}`;
		});
		return sql.join(fragments, sql`, `);
	}
}
