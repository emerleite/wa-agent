/**
 * Per-call observability ledger for `AIRouter` (v0.9).
 *
 * Every `AIRouter.route(...)` produces one row per provider attempt — a
 * single user-facing response may produce multiple rows when the cascade
 * walks several providers. Powers cost/latency/success-rate dashboards
 * without the application having to add a custom log table.
 *
 *   const ledger = new AICallLedger({ db: env.DB });
 *   const router = new AIRouter({ providers, ledger });
 *
 * Apps with their own schema retarget via `tableName` + `columnMap` +
 * `omitColumns` + `allowedExtraColumns` — the same pattern as
 * `EscalationStore` / `ConsentStore` / `AgentReviewQueue`.
 *
 * Cost is stored as INTEGER micro-USD (1/1_000_000 USD) so aggregations
 * over millions of rows stay precise. The router does NOT compute cost;
 * callers pass it on the `record(...)` row (typically via a price table —
 * see `LLMCostCalculator` for an out-of-the-box helper).
 */
import { sql } from 'drizzle-orm';
import { normalizeDb, type DB } from '../db/client.js';
import type { AICallLogRow } from '../db/schema/ai_call_log.js';

export type CallStatus =
	| 'success'
	| 'rate_limited'
	| 'timeout'
	| 'error'
	| 'parse_error'
	| 'skipped_open'
	| 'skipped_budget';

export type CallField =
	| 'id'
	| 'task'
	| 'provider'
	| 'model'
	| 'status'
	| 'httpStatus'
	| 'latencyMs'
	| 'tokensIn'
	| 'tokensOut'
	| 'estCostMicroUsd'
	| 'errorKind'
	| 'errorMessage'
	| 'tenantId'
	| 'whatsapp'
	| 'turnId'
	| 'createdAt';

export const DEFAULT_CALL_LOG_COLUMNS: Readonly<Record<CallField, string>> = Object.freeze({
	id: 'id',
	task: 'task',
	provider: 'provider',
	model: 'model',
	status: 'status',
	httpStatus: 'http_status',
	latencyMs: 'latency_ms',
	tokensIn: 'tokens_in',
	tokensOut: 'tokens_out',
	estCostMicroUsd: 'est_cost_micro_usd',
	errorKind: 'error_kind',
	errorMessage: 'error_message',
	tenantId: 'tenant_id',
	whatsapp: 'whatsapp',
	turnId: 'turn_id',
	createdAt: 'created_at',
});

const SAFE_IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

export interface AICallLedgerOptions {
	db: D1Database | DB;
	/** Physical table name. Default `'ai_call_log'`. */
	tableName?: string;
	columnMap?: Partial<Record<CallField, string>>;
	omitColumns?: ReadonlyArray<CallField>;
	allowedExtraColumns?: ReadonlyArray<string>;
}

export interface RecordCallArgs {
	task: string;
	provider: string;
	status: CallStatus;
	model?: string | null;
	httpStatus?: number | null;
	latencyMs?: number | null;
	tokensIn?: number | null;
	tokensOut?: number | null;
	/** Integer micro-USD (1/1_000_000 USD). NULL when unknown. */
	estCostMicroUsd?: number | null;
	errorKind?: string | null;
	errorMessage?: string | null;
	tenantId?: string | null;
	whatsapp?: string | null;
	/**
	 * Correlate this row to an `AgentLoop.run(...)` invocation (v0.11).
	 * NULL for standalone `AIRouter` calls with no surrounding loop.
	 */
	turnId?: string | null;
	extraColumns?: Record<string, string | number | null>;
}

export interface ListCallsOptions {
	task?: string;
	provider?: string;
	status?: CallStatus;
	tenantId?: string;
	whatsapp?: string;
	turnId?: string;
	/** ISO date range (e.g. `'2026-06-19'`). Inclusive. */
	since?: string;
	limit?: number;
}

export type CallRow = AICallLogRow;

export class AICallLedger {
	readonly db: DB;
	readonly tableName: string;
	readonly columns: Readonly<Record<CallField, string>>;
	readonly omitColumns: ReadonlySet<CallField>;
	readonly allowedExtraColumns: ReadonlySet<string>;

	constructor({ db, tableName = 'ai_call_log', columnMap, omitColumns, allowedExtraColumns }: AICallLedgerOptions) {
		if (!db) throw new Error('AICallLedger: db required');
		if (!SAFE_IDENT.test(tableName)) {
			throw new Error('AICallLedger: tableName must be a bare SQL identifier');
		}
		const merged: Record<CallField, string> = { ...DEFAULT_CALL_LOG_COLUMNS };
		if (columnMap) {
			for (const [k, v] of Object.entries(columnMap) as Array<[CallField, string | undefined]>) {
				if (v === undefined) continue;
				if (!SAFE_IDENT.test(v)) {
					throw new Error(`AICallLedger: columnMap.${k} must be a bare SQL identifier`);
				}
				merged[k] = v;
			}
		}
		const extra = new Set<string>();
		if (allowedExtraColumns) {
			for (const name of allowedExtraColumns) {
				if (!SAFE_IDENT.test(name)) {
					throw new Error(`AICallLedger: allowedExtraColumns "${name}" must be a bare SQL identifier`);
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

	async record(args: RecordCallArgs): Promise<string> {
		if (!args.task) throw new Error('AICallLedger.record: task required');
		if (!args.provider) throw new Error('AICallLedger.record: provider required');
		if (!args.status) throw new Error('AICallLedger.record: status required');

		const id = crypto.randomUUID();
		const c = this.columns;
		const framework: Array<[CallField, unknown]> = [
			['id', id],
			['task', args.task],
			['provider', args.provider],
			['model', args.model ?? null],
			['status', args.status],
			['httpStatus', args.httpStatus ?? null],
			['latencyMs', args.latencyMs ?? null],
			['tokensIn', args.tokensIn ?? null],
			['tokensOut', args.tokensOut ?? null],
			['estCostMicroUsd', args.estCostMicroUsd ?? null],
			['errorKind', args.errorKind ?? null],
			['errorMessage', args.errorMessage ?? null],
			['tenantId', args.tenantId ?? null],
			['whatsapp', args.whatsapp ?? null],
			['turnId', args.turnId ?? null],
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
					throw new Error(`AICallLedger.record: extraColumns.${name} is not in allowedExtraColumns`);
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

	async byId(id: string): Promise<CallRow | null> {
		const rows = await this.db.all<CallRow>(sql`
			SELECT ${this.selectList()} FROM ${sql.raw(this.tableName)}
			WHERE ${sql.raw(this.columns.id)} = ${id} LIMIT 1`);
		return rows[0] ?? null;
	}

	async list({ task, provider, status, tenantId, whatsapp, turnId, since, limit = 100 }: ListCallsOptions = {}): Promise<CallRow[]> {
		const c = this.columns;
		const filters = [
			task ? sql`${sql.raw(c.task)} = ${task}` : null,
			provider ? sql`${sql.raw(c.provider)} = ${provider}` : null,
			status ? sql`${sql.raw(c.status)} = ${status}` : null,
			tenantId ? sql`${sql.raw(c.tenantId)} = ${tenantId}` : null,
			whatsapp ? sql`${sql.raw(c.whatsapp)} = ${whatsapp}` : null,
			turnId ? sql`${sql.raw(c.turnId)} = ${turnId}` : null,
			since ? sql`${sql.raw(c.createdAt)} >= ${since}` : null,
		].filter((f): f is ReturnType<typeof sql> => f !== null);
		const where = filters.length ? sql` WHERE ${sql.join(filters, sql` AND `)}` : sql``;
		return await this.db.all<CallRow>(sql`
			SELECT ${this.selectList()} FROM ${sql.raw(this.tableName)}${where}
			ORDER BY ${sql.raw(c.createdAt)} DESC LIMIT ${limit}`);
	}

	async countByStatus(status: CallStatus, opts: { task?: string; tenantId?: string; since?: string } = {}): Promise<number> {
		const c = this.columns;
		const filters = [sql`${sql.raw(c.status)} = ${status}`];
		if (opts.task) filters.push(sql`${sql.raw(c.task)} = ${opts.task}`);
		if (opts.tenantId) filters.push(sql`${sql.raw(c.tenantId)} = ${opts.tenantId}`);
		if (opts.since) filters.push(sql`${sql.raw(c.createdAt)} >= ${opts.since}`);
		const rows = await this.db.all<{ n: number }>(sql`
			SELECT COUNT(*) AS n FROM ${sql.raw(this.tableName)}
			WHERE ${sql.join(filters, sql` AND `)}`);
		return rows[0]?.n ?? 0;
	}

	/**
	 * Sum of `est_cost_micro_usd` grouped by provider, filtered by
	 * optional task / tenant / time window. Returns micro-USD integers;
	 * callers divide by 1_000_000 for USD.
	 */
	async costByProvider(opts: { task?: string; tenantId?: string; since?: string } = {}): Promise<Array<{ provider: string; microUsd: number }>> {
		const c = this.columns;
		const filters: Array<ReturnType<typeof sql>> = [];
		if (opts.task) filters.push(sql`${sql.raw(c.task)} = ${opts.task}`);
		if (opts.tenantId) filters.push(sql`${sql.raw(c.tenantId)} = ${opts.tenantId}`);
		if (opts.since) filters.push(sql`${sql.raw(c.createdAt)} >= ${opts.since}`);
		const where = filters.length ? sql` WHERE ${sql.join(filters, sql` AND `)}` : sql``;
		const rows = await this.db.all<{ provider: string; microUsd: number }>(sql`
			SELECT ${sql.raw(c.provider)} AS provider,
			       COALESCE(SUM(${sql.raw(c.estCostMicroUsd)}), 0) AS "microUsd"
			FROM ${sql.raw(this.tableName)}${where}
			GROUP BY ${sql.raw(c.provider)}
			ORDER BY "microUsd" DESC`);
		return rows;
	}

	private selectList(): ReturnType<typeof sql> {
		const c = this.columns;
		const fields: Array<[CallField, string]> = [
			['id', 'id'],
			['task', 'task'],
			['provider', 'provider'],
			['model', 'model'],
			['status', 'status'],
			['httpStatus', '"httpStatus"'],
			['latencyMs', '"latencyMs"'],
			['tokensIn', '"tokensIn"'],
			['tokensOut', '"tokensOut"'],
			['estCostMicroUsd', '"estCostMicroUsd"'],
			['errorKind', '"errorKind"'],
			['errorMessage', '"errorMessage"'],
			['tenantId', '"tenantId"'],
			['whatsapp', 'whatsapp'],
			['turnId', '"turnId"'],
			['createdAt', '"createdAt"'],
		];
		const fragments = fields.map(([field, alias]) => {
			if (this.omitColumns.has(field)) {
				const defaultValue = field === 'id' || field === 'task' || field === 'provider' || field === 'status' || field === 'createdAt'
					? sql`''`
					: sql`NULL`;
				return sql`${defaultValue} AS ${sql.raw(alias)}`;
			}
			return sql`${sql.raw(c[field])} AS ${sql.raw(alias)}`;
		});
		return sql.join(fragments, sql`, `);
	}
}
