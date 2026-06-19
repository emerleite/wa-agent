/**
 * Structured escalation log + pluggable notifier.
 *
 * Where the pipeline's `PolicyGate` produces `action: 'escalate'` decisions
 * but had no place to record them or anyone to notify, `EscalationStore`
 * persists each escalation to D1 and (optionally) fans out via an
 * `EscalationNotifier` (HTTP webhook, Slack, no-op for tests).
 *
 *   const escalations = new EscalationStore({
 *     db: agent.db,
 *     notifier: new SlackNotifier({ webhookUrl: env.SLACK_ESCALATION_WEBHOOK }),
 *   });
 *
 *   // The Agent automatically records escalations from reply.ai() when a
 *   // pipeline decision has action='escalate' AND `escalationStore` is set
 *   // on the Agent. You can also record manually:
 *   const id = await escalations.record({
 *     whatsapp: ctx.user.whatsapp,
 *     reason: 'crisis',
 *     urgency: 'critical',
 *     message: 'Trigger word detected via regex.',
 *     traceId: ctx.traceId,
 *   });
 *
 * `resolve(id, { resolvedBy, notes })` closes the row; `list({ activeOnly })`
 * surfaces open ones for dashboards.
 */
import { sql } from 'drizzle-orm';
import { normalizeDb, type DB } from '../db/client.js';
import type { EscalationRow } from '../db/schema/escalations.js';

export type EscalationUrgency = 'low' | 'medium' | 'high' | 'critical';
export type EscalationReason =
	| 'crisis'
	| 'ambiguous'
	| 'policy_violation'
	| 'patient_requested'
	| 'tool_failed'
	| 'cost_limit'
	| (string & {});

export interface EscalateArgs {
	/**
	 * E.164 identifier of the user whose turn was escalated. Required for the
	 * default schema; may be omitted when `omitColumns` includes `'whatsapp'`
	 * (the app routes via a different column, e.g. a `patient_id` FK). When
	 * omitted, the in-memory `EscalationRow.whatsapp` field defaults to `''`
	 * for notifier consumers.
	 */
	whatsapp?: string | null;
	reason: EscalationReason;
	urgency: EscalationUrgency;
	message: string;
	traceId?: string | null;
	tenantId?: string | null;
	/**
	 * Extra columns INSERTed alongside the framework columns — used when the
	 * app's schema has columns the framework doesn't model (e.g. psico's
	 * `patient_id` FK). Keys must appear in `EscalationStoreOptions.allowedExtraColumns`;
	 * unlisted keys throw at runtime. Values are parameterized — only the
	 * column-name identifier needs the allowlist.
	 */
	extraColumns?: Record<string, string | number | null>;
}

export interface ResolveArgs {
	resolvedBy?: string | null;
	notes?: string | null;
}

export interface ListEscalationsOptions {
	activeOnly?: boolean;
	urgency?: EscalationUrgency;
	tenantId?: string;
	whatsapp?: string;
	limit?: number;
}

export interface EscalationNotifier {
	notify(escalation: EscalationRow): Promise<void>;
}

/**
 * Logical column names on the row shape (`EscalationRow`). Used by
 * `columnMap` to point each one at a different physical column name when
 * an app already has its own table.
 */
export type EscalationField =
	| 'id'
	| 'whatsapp'
	| 'reason'
	| 'urgency'
	| 'message'
	| 'traceId'
	| 'tenantId'
	| 'createdAt'
	| 'resolvedAt'
	| 'resolvedBy'
	| 'notes';

/**
 * Default column names — mirror `migrations/013_escalations.sql`. Override
 * via `EscalationStoreOptions.columnMap` to retarget an app-owned table.
 */
export const DEFAULT_ESCALATION_COLUMNS: Readonly<Record<EscalationField, string>> = Object.freeze({
	id: 'id',
	whatsapp: 'whatsapp',
	reason: 'reason',
	urgency: 'urgency',
	message: 'message',
	traceId: 'trace_id',
	tenantId: 'tenant_id',
	createdAt: 'created_at',
	resolvedAt: 'resolved_at',
	resolvedBy: 'resolved_by',
	notes: 'notes',
});

export interface EscalationStoreOptions {
	/**
	 * D1 binding OR a pre-built Drizzle client (any schema). v0.7+:
	 * normalized internally; pass `env.DB` directly or your own
	 * `createDb(env.DB)` — both work.
	 */
	db: D1Database | DB;
	/** Optional sink for newly-recorded escalations. Default: NoOpNotifier. */
	notifier?: EscalationNotifier | null;
	/**
	 * Minimum urgency that triggers the notifier. Below this, only D1 is
	 * touched. Default 'medium' — `low` escalations are recorded silently.
	 */
	notifyAtOrAbove?: EscalationUrgency;
	/**
	 * Physical table name. Default `'escalations'`. Override when the app
	 * already owns the schema and you want the store to write to that.
	 *
	 * Must be a bare SQL identifier (alphanumeric + underscores). Rejected
	 * at construction; this is the same defence-in-depth `ContentGenerator`
	 * uses.
	 */
	tableName?: string;
	/**
	 * Per-field column-name override. Pass only the fields whose physical
	 * column differs from the default; the rest fall through to
	 * `DEFAULT_ESCALATION_COLUMNS`.
	 *
	 *   columnMap: { notes: 'resolution' }
	 *     // psico's column is `resolution` instead of `notes`.
	 *
	 * Like `tableName`, each value must be a bare SQL identifier.
	 */
	columnMap?: Partial<Record<EscalationField, string>>;
	/**
	 * Logical fields to skip from INSERT entirely. Use when the app's table
	 * has no such column — e.g. psico's `escalations` routes via `patient_id`
	 * and has no `whatsapp` column, so `omitColumns: ['whatsapp']` keeps the
	 * INSERT off that column. Omitted fields still flow into the in-memory
	 * `EscalationRow` for notifier consumers (with empty defaults when not
	 * populated via `extraColumns`).
	 */
	omitColumns?: ReadonlyArray<EscalationField>;
	/**
	 * Allowlist of physical column names accepted from `EscalateArgs.extraColumns`.
	 * Required when callers pass `extraColumns` — keys not in this list throw
	 * at runtime. Each entry must be a bare SQL identifier; values flow as
	 * parameterized bindings.
	 *
	 *   allowedExtraColumns: ['patient_id']
	 *     // psico tracks the patient FK alongside the framework columns.
	 */
	allowedExtraColumns?: ReadonlyArray<string>;
}

const URGENCY_RANK: Record<EscalationUrgency, number> = {
	low: 0,
	medium: 1,
	high: 2,
	critical: 3,
};

const SAFE_IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

export class EscalationStore {
	readonly db: DB;
	readonly notifier: EscalationNotifier;
	readonly notifyAtOrAbove: EscalationUrgency;
	readonly tableName: string;
	readonly columns: Readonly<Record<EscalationField, string>>;
	readonly omitColumns: ReadonlySet<EscalationField>;
	readonly allowedExtraColumns: ReadonlySet<string>;

	constructor({
		db,
		notifier = null,
		notifyAtOrAbove = 'medium',
		tableName = 'escalations',
		columnMap,
		omitColumns,
		allowedExtraColumns,
	}: EscalationStoreOptions) {
		if (!db) throw new Error('EscalationStore: db required');
		if (!SAFE_IDENT.test(tableName)) {
			throw new Error('EscalationStore: tableName must be a bare SQL identifier');
		}
		const merged: Record<EscalationField, string> = { ...DEFAULT_ESCALATION_COLUMNS };
		if (columnMap) {
			for (const [k, v] of Object.entries(columnMap) as Array<[EscalationField, string | undefined]>) {
				if (v === undefined) continue;
				if (!SAFE_IDENT.test(v)) {
					throw new Error(`EscalationStore: columnMap.${k} must be a bare SQL identifier`);
				}
				merged[k] = v;
			}
		}
		const extra = new Set<string>();
		if (allowedExtraColumns) {
			for (const name of allowedExtraColumns) {
				if (!SAFE_IDENT.test(name)) {
					throw new Error(`EscalationStore: allowedExtraColumns "${name}" must be a bare SQL identifier`);
				}
				extra.add(name);
			}
		}
		this.db = normalizeDb(db);
		this.notifier = notifier ?? new NoOpNotifier();
		this.notifyAtOrAbove = notifyAtOrAbove;
		this.tableName = tableName;
		this.columns = Object.freeze(merged);
		this.omitColumns = new Set(omitColumns ?? []);
		this.allowedExtraColumns = extra;
	}

	/**
	 * Insert a row, fire the notifier asynchronously, return the new id.
	 * Failure to notify never blocks the record path — notifier errors are
	 * caught + logged so a downstream outage can't break escalation logging.
	 */
	async record(args: EscalateArgs): Promise<string> {
		if (!args.reason) throw new Error('EscalationStore.record: reason required');
		if (!args.message) throw new Error('EscalationStore.record: message required');
		// whatsapp is required UNLESS the caller omitted that column from the
		// schema — apps that route via patient_id (psico) or another FK set
		// `omitColumns: ['whatsapp']` and leave `args.whatsapp` empty.
		if (!this.omitColumns.has('whatsapp') && !args.whatsapp) {
			throw new Error('EscalationStore.record: whatsapp required (or set omitColumns: [\'whatsapp\'])');
		}

		const id = crypto.randomUUID();
		const c = this.columns;

		// Build the INSERT row as (logicalField, value) pairs, skipping fields
		// in `omitColumns`. `id` always inserted. Framework-managed columns
		// (createdAt, resolvedAt, resolvedBy, notes) skipped from the INSERT
		// regardless — they're driven by `resolve()`/`createdAt` default.
		const framework: Array<[EscalationField, unknown]> = [
			['id', id],
			['whatsapp', args.whatsapp ?? ''],
			['reason', args.reason],
			['urgency', args.urgency],
			['message', args.message],
			['traceId', args.traceId ?? null],
			['tenantId', args.tenantId ?? null],
		];
		const insertColumns: Array<ReturnType<typeof sql>> = [];
		const insertValues: Array<unknown> = [];
		for (const [field, value] of framework) {
			if (this.omitColumns.has(field)) continue;
			insertColumns.push(sql.raw(c[field]));
			insertValues.push(value);
		}
		if (args.extraColumns) {
			for (const [name, value] of Object.entries(args.extraColumns)) {
				if (!this.allowedExtraColumns.has(name)) {
					throw new Error(`EscalationStore.record: extraColumns.${name} is not in allowedExtraColumns`);
				}
				insertColumns.push(sql.raw(name));
				insertValues.push(value);
			}
		}
		const stmt = sql`
			INSERT INTO ${sql.raw(this.tableName)} (${sql.join(insertColumns, sql`, `)})
			VALUES (${sql.join(insertValues.map((v) => sql`${v}`), sql`, `)})`;
		await this.db.run(stmt);

		if (URGENCY_RANK[args.urgency] >= URGENCY_RANK[this.notifyAtOrAbove]) {
			try {
				const row = await this.byId(id);
				if (row) await this.notifier.notify(row);
			} catch (e) {
				console.error('[EscalationStore] notifier threw:', e instanceof Error ? e.message : e);
			}
		}

		return id;
	}

	async byId(id: string): Promise<EscalationRow | null> {
		const stmt = sql`
			SELECT ${this.selectList()} FROM ${sql.raw(this.tableName)}
			WHERE ${sql.raw(this.columns.id)} = ${id} LIMIT 1`;
		const rows = await this.db.all<EscalationRow>(stmt);
		return rows[0] ?? null;
	}

	async resolve(id: string, args: ResolveArgs = {}): Promise<boolean> {
		const c = this.columns;
		const stmt = sql`
			UPDATE ${sql.raw(this.tableName)}
			SET ${sql.raw(c.resolvedAt)} = (datetime('now')),
			    ${sql.raw(c.resolvedBy)} = ${args.resolvedBy ?? null},
			    ${sql.raw(c.notes)} = ${args.notes ?? null}
			WHERE ${sql.raw(c.id)} = ${id} AND ${sql.raw(c.resolvedAt)} IS NULL
			RETURNING ${sql.raw(c.id)} AS id`;
		const rows = await this.db.all<{ id: string }>(stmt);
		return rows.length > 0;
	}

	async list({ activeOnly = true, urgency, tenantId, whatsapp, limit = 100 }: ListEscalationsOptions = {}): Promise<EscalationRow[]> {
		const c = this.columns;
		const filters = [
			activeOnly ? sql`${sql.raw(c.resolvedAt)} IS NULL` : null,
			urgency ? sql`${sql.raw(c.urgency)} = ${urgency}` : null,
			tenantId ? sql`${sql.raw(c.tenantId)} = ${tenantId}` : null,
			whatsapp ? sql`${sql.raw(c.whatsapp)} = ${whatsapp}` : null,
		].filter((f): f is ReturnType<typeof sql> => f !== null);
		const whereClause = filters.length
			? sql` WHERE ${sql.join(filters, sql` AND `)}`
			: sql``;
		const stmt = sql`
			SELECT ${this.selectList()} FROM ${sql.raw(this.tableName)}${whereClause}
			ORDER BY ${sql.raw(c.createdAt)} DESC LIMIT ${limit}`;
		return await this.db.all<EscalationRow>(stmt);
	}

	/** Number of currently open escalations, optionally filtered by urgency. */
	async openCount({ urgency, tenantId }: { urgency?: EscalationUrgency; tenantId?: string } = {}): Promise<number> {
		const c = this.columns;
		const filters = [
			sql`${sql.raw(c.resolvedAt)} IS NULL`,
			urgency ? sql`${sql.raw(c.urgency)} = ${urgency}` : null,
			tenantId ? sql`${sql.raw(c.tenantId)} = ${tenantId}` : null,
		].filter((f): f is ReturnType<typeof sql> => f !== null);
		const stmt = sql`
			SELECT COUNT(*) AS n FROM ${sql.raw(this.tableName)}
			WHERE ${sql.join(filters, sql` AND `)}`;
		const rows = await this.db.all<{ n: number }>(stmt);
		return rows[0]?.n ?? 0;
	}

	/**
	 * Build the SELECT projection that aliases physical columns back to the
	 * logical `EscalationRow` field names. Lets every caller treat the row
	 * shape as the same regardless of the column map.
	 */
	private selectList(): ReturnType<typeof sql> {
		const c = this.columns;
		const fields: Array<[EscalationField, string]> = [
			['id', 'id'],
			['whatsapp', 'whatsapp'],
			['reason', 'reason'],
			['urgency', 'urgency'],
			['message', 'message'],
			['traceId', '"traceId"'],
			['tenantId', '"tenantId"'],
			['createdAt', '"createdAt"'],
			['resolvedAt', '"resolvedAt"'],
			['resolvedBy', '"resolvedBy"'],
			['notes', 'notes'],
		];
		const fragments = fields.map(([field, alias]) => {
			// When a column is omitted from the schema, SELECT a literal default
			// so the row shape still satisfies `EscalationRow`. Notifiers + list
			// consumers can detect "this app doesn't track that field" by reading
			// the empty/null value.
			if (this.omitColumns.has(field)) {
				const defaultValue = field === 'whatsapp' || field === 'reason' || field === 'urgency' || field === 'message' || field === 'id' || field === 'createdAt'
					? sql`''`
					: sql`NULL`;
				return sql`${defaultValue} AS ${sql.raw(alias)}`;
			}
			return sql`${sql.raw(c[field])} AS ${sql.raw(alias)}`;
		});
		return sql.join(fragments, sql`, `);
	}
}

// ---- Notifiers ----

export class NoOpNotifier implements EscalationNotifier {
	async notify(_escalation: EscalationRow): Promise<void> {
		// intentional no-op
	}
}

export interface HttpNotifierOptions {
	url: string;
	headers?: Record<string, string>;
	/** Build the POST body. Default: JSON-stringify the row. */
	bodyFor?: (row: EscalationRow) => BodyInit;
}

export class HttpNotifier implements EscalationNotifier {
	readonly url: string;
	readonly headers: Record<string, string>;
	readonly bodyFor: (row: EscalationRow) => BodyInit;

	constructor({ url, headers, bodyFor }: HttpNotifierOptions) {
		if (!url) throw new Error('HttpNotifier: url required');
		this.url = url;
		this.headers = { 'content-type': 'application/json', ...(headers ?? {}) };
		this.bodyFor = bodyFor ?? ((row) => JSON.stringify(row));
	}

	async notify(row: EscalationRow): Promise<void> {
		const r = await fetch(this.url, { method: 'POST', headers: this.headers, body: this.bodyFor(row) });
		if (!r.ok) {
			throw new Error(`HttpNotifier ${r.status}: ${(await r.text()).slice(0, 200)}`);
		}
	}
}

export interface SlackNotifierOptions {
	/** Slack incoming-webhook URL. */
	webhookUrl: string;
	/** Override the rendered message. Default: a short summary with urgency emoji. */
	render?: (row: EscalationRow) => { text: string; blocks?: unknown[] };
}

export class SlackNotifier implements EscalationNotifier {
	readonly webhookUrl: string;
	readonly render: (row: EscalationRow) => { text: string; blocks?: unknown[] };

	constructor({ webhookUrl, render }: SlackNotifierOptions) {
		if (!webhookUrl) throw new Error('SlackNotifier: webhookUrl required');
		this.webhookUrl = webhookUrl;
		this.render = render ?? defaultSlackRender;
	}

	async notify(row: EscalationRow): Promise<void> {
		const body = JSON.stringify(this.render(row));
		const r = await fetch(this.webhookUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
		if (!r.ok) throw new Error(`SlackNotifier ${r.status}`);
	}
}

const URGENCY_EMOJI: Record<EscalationUrgency, string> = {
	low: ':information_source:',
	medium: ':warning:',
	high: ':rotating_light:',
	critical: ':sos:',
};

function defaultSlackRender(row: EscalationRow): { text: string; blocks?: unknown[] } {
	const emoji = URGENCY_EMOJI[row.urgency as EscalationUrgency] ?? ':warning:';
	const tenant = row.tenantId ? ` (tenant ${row.tenantId})` : '';
	const message = (row.message ?? '').slice(0, 240);
	return {
		text: `${emoji} *${row.urgency.toUpperCase()}* — ${row.reason}${tenant}\n` +
			`from ${row.whatsapp}: ${message}` +
			(row.traceId ? `\n_trace ${row.traceId}_` : ''),
	};
}
