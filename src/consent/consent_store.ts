/**
 * Per-user consent tracking + pipeline-level gate.
 *
 * Where it sits: between "user opted in to chat with the bot" (handled by
 * `LeadStore.optIn`) and "user opted in to AI / data retention / marketing
 * messages specifically". Most apps need both — the lead opt-in is a chat
 * boundary, the consent is a feature boundary.
 *
 *   const consents = new ConsentStore({ db: agent.db });
 *
 *   // Grant on a button tap from the welcome flow
 *   agent.button('consent_ai_processing', async ({ user, reply, inbound }) => {
 *     await consents.grant(user.whatsapp, 'ai_processing', { evidence: inbound.wamid });
 *     await reply.text('Obrigado! Pode mandar suas perguntas.');
 *   });
 *
 *   // Block the AI turn when the user hasn't consented yet
 *   agent.pipeline.before('llm', consentGate({ store: consents, type: 'ai_processing' }));
 *
 * Schema flexibility:
 *
 *   - `tableName` + `columnMap` follow the same pattern as `EscalationStore`
 *     — apps with their own richer table (psico has `consents` with
 *     `tenant_id` NOT NULL FK + `patient_id` FK + `granted` boolean +
 *     `revoked_at` audit log) point the store at their schema. Identifier
 *     names are validated at construction (`SAFE_IDENT`).
 *   - `omitColumns: ['whatsapp']` lets apps route via a different identity
 *     column (psico stores `patient_id`); pass the identifier via
 *     `extraColumns` instead.
 *
 * Storage interface:
 *
 *   - `has(whatsapp, type)`         → boolean
 *   - `grant(whatsapp, type, opts?)` → void
 *   - `revoke(whatsapp, type)`      → void
 *   - `list(whatsapp)`              → ConsentRow[]
 *
 * The pipeline gate (`consentGate(...)`) short-circuits the turn with a
 * configurable action (default `silent`). When the gate fires it can also
 * emit a `consent_blocked` event into the framework event stream — opt-in
 * via the optional `emit` callback.
 */
import { sql } from 'drizzle-orm';
import type { DB } from '../db/client.js';
import type { PipelineContext, PipelineDecision, PipelineStep, StepResult } from '../pipeline/types.js';

export interface ConsentRow {
	whatsapp: string;
	type: string;
	grantedAt: string;
	revokedAt: string | null;
	tenantId: string | null;
	evidence: string | null;
}

export type ConsentField =
	| 'whatsapp'
	| 'type'
	| 'grantedAt'
	| 'revokedAt'
	| 'tenantId'
	| 'evidence';

export const DEFAULT_CONSENT_COLUMNS: Readonly<Record<ConsentField, string>> = Object.freeze({
	whatsapp: 'whatsapp',
	type: 'type',
	grantedAt: 'granted_at',
	revokedAt: 'revoked_at',
	tenantId: 'tenant_id',
	evidence: 'evidence',
});

const SAFE_IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

export interface ConsentStoreOptions {
	db: DB;
	/** Physical table name. Default `'user_consents'`. */
	tableName?: string;
	/** Per-field column-name override (same pattern as `EscalationStore`). */
	columnMap?: Partial<Record<ConsentField, string>>;
	/** Logical fields to skip from INSERT entirely. */
	omitColumns?: ReadonlyArray<ConsentField>;
	/** Allowlist of extra column names accepted from `grant({ extraColumns })`. */
	allowedExtraColumns?: ReadonlyArray<string>;
	/**
	 * Default tenantId to write when none is supplied to `grant()`. Useful
	 * when a per-tenant agent factory builds one ConsentStore per tenant.
	 */
	defaultTenantId?: string | null;
}

export interface GrantOptions {
	evidence?: string | null;
	tenantId?: string | null;
	extraColumns?: Record<string, string | number | null>;
}

export class ConsentStore {
	readonly db: DB;
	readonly tableName: string;
	readonly columns: Readonly<Record<ConsentField, string>>;
	readonly omitColumns: ReadonlySet<ConsentField>;
	readonly allowedExtraColumns: ReadonlySet<string>;
	readonly defaultTenantId: string | null;

	constructor({
		db,
		tableName = 'user_consents',
		columnMap,
		omitColumns,
		allowedExtraColumns,
		defaultTenantId = null,
	}: ConsentStoreOptions) {
		if (!db) throw new Error('ConsentStore: db required');
		if (!SAFE_IDENT.test(tableName)) {
			throw new Error('ConsentStore: tableName must be a bare SQL identifier');
		}
		const merged: Record<ConsentField, string> = { ...DEFAULT_CONSENT_COLUMNS };
		if (columnMap) {
			for (const [k, v] of Object.entries(columnMap) as Array<[ConsentField, string | undefined]>) {
				if (v === undefined) continue;
				if (!SAFE_IDENT.test(v)) {
					throw new Error(`ConsentStore: columnMap.${k} must be a bare SQL identifier`);
				}
				merged[k] = v;
			}
		}
		const extra = new Set<string>();
		if (allowedExtraColumns) {
			for (const name of allowedExtraColumns) {
				if (!SAFE_IDENT.test(name)) {
					throw new Error(`ConsentStore: allowedExtraColumns "${name}" must be a bare SQL identifier`);
				}
				extra.add(name);
			}
		}
		this.db = db;
		this.tableName = tableName;
		this.columns = Object.freeze(merged);
		this.omitColumns = new Set(omitColumns ?? []);
		this.allowedExtraColumns = extra;
		this.defaultTenantId = defaultTenantId;
	}

	/**
	 * @returns true when a non-revoked consent of `type` exists for `whatsapp`.
	 *
	 * Multi-tenant: when `defaultTenantId` is set the lookup is scoped to it.
	 * Pass an explicit `tenantId` to override.
	 */
	async has(whatsapp: string, type: string, tenantId?: string | null): Promise<boolean> {
		const tid = tenantId ?? this.defaultTenantId;
		const c = this.columns;
		const filters = [
			sql`${sql.raw(c.type)} = ${type}`,
			sql`${sql.raw(c.revokedAt)} IS NULL`,
		];
		if (!this.omitColumns.has('whatsapp')) {
			filters.push(sql`${sql.raw(c.whatsapp)} = ${whatsapp}`);
		}
		if (tid !== null && !this.omitColumns.has('tenantId')) {
			filters.push(sql`${sql.raw(c.tenantId)} = ${tid}`);
		}
		const stmt = sql`
			SELECT 1 AS one FROM ${sql.raw(this.tableName)}
			WHERE ${sql.join(filters, sql` AND `)} LIMIT 1`;
		const rows = await this.db.all<{ one: number }>(stmt);
		return rows.length > 0;
	}

	/**
	 * Insert (or refresh) a consent. Idempotent at the primary-key level —
	 * an existing non-revoked row stays as-is; an existing revoked row gets
	 * its `revoked_at` cleared so the user can re-grant.
	 */
	async grant(whatsapp: string, type: string, opts: GrantOptions = {}): Promise<void> {
		if (!type) throw new Error('ConsentStore.grant: type required');
		if (!this.omitColumns.has('whatsapp') && !whatsapp) {
			throw new Error('ConsentStore.grant: whatsapp required (or set omitColumns: [\'whatsapp\'])');
		}

		const tid = opts.tenantId ?? this.defaultTenantId;
		const c = this.columns;
		const framework: Array<[ConsentField, unknown]> = [
			['whatsapp', whatsapp],
			['type', type],
			['tenantId', tid],
			['evidence', opts.evidence ?? null],
		];
		const insertColumns: Array<ReturnType<typeof sql>> = [];
		const insertValues: Array<unknown> = [];
		for (const [field, value] of framework) {
			if (this.omitColumns.has(field)) continue;
			insertColumns.push(sql.raw(c[field]));
			insertValues.push(value);
		}
		if (opts.extraColumns) {
			for (const [name, value] of Object.entries(opts.extraColumns)) {
				if (!this.allowedExtraColumns.has(name)) {
					throw new Error(`ConsentStore.grant: extraColumns.${name} is not in allowedExtraColumns`);
				}
				insertColumns.push(sql.raw(name));
				insertValues.push(value);
			}
		}
		// ON CONFLICT clears revoked_at + refreshes evidence so re-grants work.
		const stmt = sql`
			INSERT INTO ${sql.raw(this.tableName)} (${sql.join(insertColumns, sql`, `)})
			VALUES (${sql.join(insertValues.map((v) => sql`${v}`), sql`, `)})
			ON CONFLICT DO UPDATE SET
				${sql.raw(c.revokedAt)} = NULL,
				${sql.raw(c.evidence)} = COALESCE(excluded.${sql.raw(c.evidence)}, ${sql.raw(this.tableName)}.${sql.raw(c.evidence)})`;
		await this.db.run(stmt);
	}

	/**
	 * Mark an existing consent revoked. Idempotent — a non-existent or
	 * already-revoked row results in 0 affected rows; the call still succeeds.
	 */
	async revoke(whatsapp: string, type: string, tenantId?: string | null): Promise<void> {
		const tid = tenantId ?? this.defaultTenantId;
		const c = this.columns;
		const filters = [sql`${sql.raw(c.type)} = ${type}`];
		if (!this.omitColumns.has('whatsapp')) {
			filters.push(sql`${sql.raw(c.whatsapp)} = ${whatsapp}`);
		}
		if (tid !== null && !this.omitColumns.has('tenantId')) {
			filters.push(sql`${sql.raw(c.tenantId)} = ${tid}`);
		}
		const stmt = sql`
			UPDATE ${sql.raw(this.tableName)}
			SET ${sql.raw(c.revokedAt)} = (datetime('now'))
			WHERE ${sql.join(filters, sql` AND `)} AND ${sql.raw(c.revokedAt)} IS NULL`;
		await this.db.run(stmt);
	}

	/** All consents (revoked + active) for one user. */
	async list(whatsapp: string, tenantId?: string | null): Promise<ConsentRow[]> {
		const tid = tenantId ?? this.defaultTenantId;
		const c = this.columns;
		const filters: Array<ReturnType<typeof sql>> = [];
		if (!this.omitColumns.has('whatsapp')) {
			filters.push(sql`${sql.raw(c.whatsapp)} = ${whatsapp}`);
		}
		if (tid !== null && !this.omitColumns.has('tenantId')) {
			filters.push(sql`${sql.raw(c.tenantId)} = ${tid}`);
		}
		const where = filters.length ? sql` WHERE ${sql.join(filters, sql` AND `)}` : sql``;
		const stmt = sql`
			SELECT ${this.selectList()} FROM ${sql.raw(this.tableName)}${where}
			ORDER BY ${sql.raw(c.grantedAt)} DESC`;
		return await this.db.all<ConsentRow>(stmt);
	}

	private selectList(): ReturnType<typeof sql> {
		const c = this.columns;
		const fields: Array<[ConsentField, string]> = [
			['whatsapp', 'whatsapp'],
			['type', 'type'],
			['grantedAt', '"grantedAt"'],
			['revokedAt', '"revokedAt"'],
			['tenantId', '"tenantId"'],
			['evidence', 'evidence'],
		];
		const fragments = fields.map(([field, alias]) => {
			if (this.omitColumns.has(field)) {
				const defaultValue = field === 'whatsapp' || field === 'type' || field === 'grantedAt'
					? sql`''`
					: sql`NULL`;
				return sql`${defaultValue} AS ${sql.raw(alias)}`;
			}
			return sql`${sql.raw(c[field])} AS ${sql.raw(alias)}`;
		});
		return sql.join(fragments, sql`, `);
	}
}

// ---- Pipeline integration ----

export type ConsentGateAction = 'silent' | 'escalate' | 'reply';

export interface ConsentGateOptions {
	store: ConsentStore;
	/** Consent type to check (e.g. 'ai_processing'). */
	type: string;
	/**
	 * Pipeline action when the user hasn't granted consent. Default `'silent'`
	 * — produces no reply and stops the pipeline.
	 */
	action?: ConsentGateAction;
	/**
	 * Reply text used when `action === 'reply'`. Required in that case.
	 * Ignored otherwise.
	 */
	reply?: string;
	/**
	 * Reason tag emitted on the short-circuit decision. Default `'consent_required'`.
	 * Surfaces in `agent_decision` events for funnel analysis.
	 */
	reason?: string;
	/** Step name shown in pipeline-error reports. Default `'consent_gate'`. */
	stepName?: string;
	/**
	 * Optional callback invoked when the gate fires. Useful for observability
	 * (emit `consent_blocked` to Analytics Engine). Errors here are caught
	 * + logged so the gate stays resilient.
	 */
	onBlocked?: (ctx: PipelineContext) => void | Promise<void>;
}

/**
 * Build a pipeline step that short-circuits the turn when the user has
 * NOT granted the required consent. Insert before the LLM step:
 *
 *   pipeline.before('llm', consentGate({ store, type: 'ai_processing' }));
 *
 * The gate reads `ctx.whatsapp` (and `ctx.tenantId` if your pipeline carries
 * it). Apps that route via a different identity column point their
 * ConsentStore at the right schema via columnMap — the gate doesn't care
 * about the physical layout.
 */
export function consentGate(opts: ConsentGateOptions): PipelineStep {
	const {
		store,
		type,
		action = 'silent',
		reply: replyText,
		reason = 'consent_required',
		stepName = 'consent_gate',
		onBlocked,
	} = opts;
	if (!store) throw new Error('consentGate: store required');
	if (!type) throw new Error('consentGate: type required');
	if (action === 'reply' && !replyText) {
		throw new Error('consentGate: reply text required when action="reply"');
	}

	return {
		name: stepName,
		async run(ctx: PipelineContext, _decision: PipelineDecision): Promise<StepResult> {
			const tenantId = (ctx as PipelineContext & { tenantId?: string | null }).tenantId ?? null;
			const granted = await store.has(ctx.whatsapp, type, tenantId);
			if (granted) return {};

			if (onBlocked) {
				try {
					await onBlocked(ctx);
				} catch (e) {
					console.error('[consentGate] onBlocked threw:', e instanceof Error ? e.message : e);
				}
			}

			const stop: StepResult = { reason, stop: true, action };
			if (action === 'reply' && replyText) {
				stop.reply = { answer: replyText, threadId: ctx.threadId ?? '' };
			}
			return stop;
		},
	};
}
