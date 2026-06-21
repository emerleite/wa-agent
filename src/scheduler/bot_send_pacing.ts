/**
 * Cross-category pacing primitive for bot-initiated sends (v0.9.1).
 *
 * The problem this solves: a bot that runs multiple cron handlers
 * (devotional broadcast, sequential-plan day, engagement nudge, salvage
 * window-close touch, opportunistic ads) needs two protections against
 * spamming users:
 *
 *   1. A minimum gap between any two bot-initiated sends to the same user
 *      ("no two messages within 60 min"). Prevents bunching when cron
 *      handlers all fire on the same minute.
 *   2. A per-category daily cap ("ads ≤3/day per user"). Keeps
 *      category-specific ceilings without scattered if-statements in
 *      handlers.
 *
 * Both gates are SQL queries against `bot_send_log`. Apps splice them via
 * `canSend(...)` before scheduling a send and call `recordSent(...)` after
 * a successful dispatch.
 *
 *   const pacing = new BotSendPacing({ db: env.DB });
 *
 *   for (const candidate of audience) {
 *     if (!(await pacing.canSend(candidate.whatsapp, {
 *       category: 'engagement',
 *       minGapMinutes: 60,
 *       dailyCap: 4,
 *     }))) continue;
 *     const ok = await agent.client.sendText(candidate.whatsapp, body);
 *     if (ok) await pacing.recordSent(candidate.whatsapp, 'engagement');
 *   }
 *
 * Webhook-reply sends (the bot answering an inbound message) deliberately
 * do NOT participate — they're inside an active conversation, where the
 * user already triggered the turn.
 *
 * Apps with their own richer schema (extra FK columns, audit fields)
 * follow the same `tableName` + `columnMap` + `omitColumns` +
 * `allowedExtraColumns` pattern as `EscalationStore` / `ConsentStore` /
 * `AgentReviewQueue` / `AICallLedger`.
 */
import { sql } from 'drizzle-orm';
import { normalizeDb, type DB } from '../db/client.js';
import type { BotSendLogRow } from '../db/schema/bot_send_log.js';

export type PacingField = 'id' | 'whatsapp' | 'category' | 'tenantId' | 'sentAt' | 'date';

export const DEFAULT_PACING_COLUMNS: Readonly<Record<PacingField, string>> = Object.freeze({
	id: 'id',
	whatsapp: 'whatsapp',
	category: 'category',
	tenantId: 'tenant_id',
	sentAt: 'sent_at',
	date: 'date',
});

const SAFE_IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

export interface BotSendPacingOptions {
	db: D1Database | DB;
	tableName?: string;
	columnMap?: Partial<Record<PacingField, string>>;
	omitColumns?: ReadonlyArray<PacingField>;
	allowedExtraColumns?: ReadonlyArray<string>;
	/**
	 * Tenant scope. When set, both `recordSent` writes the value and
	 * `canSend` / `countSentToday` filter by it. `null` (default) =
	 * single-tenant, no filtering.
	 */
	tenantId?: string | null;
}

export interface CanSendOptions {
	/**
	 * When set, the daily-cap check is scoped to rows with this category.
	 * When unset, the cap counts every row for the user today regardless
	 * of category. (Use a category-scoped cap for "ads ≤3/day"; use a
	 * total cap for "any send ≤4/day".)
	 */
	category?: string;
	/**
	 * Minimum minutes since the last bot-initiated send to this user
	 * (counting every category). `0` or `null` disables the gap check.
	 * Default `60`.
	 */
	minGapMinutes?: number | null;
	/**
	 * Maximum sends per day (scoped to `category` when set). `null` (default)
	 * disables the cap check.
	 */
	dailyCap?: number | null;
}

export interface RecordSentOptions {
	extraColumns?: Record<string, string | number | null>;
}

export type BotSendRow = BotSendLogRow;

export class BotSendPacing {
	readonly db: DB;
	readonly tableName: string;
	readonly columns: Readonly<Record<PacingField, string>>;
	readonly omitColumns: ReadonlySet<PacingField>;
	readonly allowedExtraColumns: ReadonlySet<string>;
	readonly tenantId: string | null;

	constructor({
		db,
		tableName = 'bot_send_log',
		columnMap,
		omitColumns,
		allowedExtraColumns,
		tenantId = null,
	}: BotSendPacingOptions) {
		if (!db) throw new Error('BotSendPacing: db required');
		if (!SAFE_IDENT.test(tableName)) {
			throw new Error('BotSendPacing: tableName must be a bare SQL identifier');
		}
		const merged: Record<PacingField, string> = { ...DEFAULT_PACING_COLUMNS };
		if (columnMap) {
			for (const [k, v] of Object.entries(columnMap) as Array<[PacingField, string | undefined]>) {
				if (v === undefined) continue;
				if (!SAFE_IDENT.test(v)) {
					throw new Error(`BotSendPacing: columnMap.${k} must be a bare SQL identifier`);
				}
				merged[k] = v;
			}
		}
		const extra = new Set<string>();
		if (allowedExtraColumns) {
			for (const name of allowedExtraColumns) {
				if (!SAFE_IDENT.test(name)) {
					throw new Error(`BotSendPacing: allowedExtraColumns "${name}" must be a bare SQL identifier`);
				}
				extra.add(name);
			}
		}
		this.db = normalizeDb(db);
		this.tableName = tableName;
		this.columns = Object.freeze(merged);
		this.omitColumns = new Set(omitColumns ?? []);
		this.allowedExtraColumns = extra;
		this.tenantId = tenantId;
	}

	/**
	 * Atomic insert of one sent row. Call AFTER a successful WhatsApp
	 * dispatch — failed sends should not consume the daily cap.
	 */
	async recordSent(whatsapp: string, category: string, opts: RecordSentOptions = {}): Promise<void> {
		if (!whatsapp) throw new Error('BotSendPacing.recordSent: whatsapp required');
		if (!category) throw new Error('BotSendPacing.recordSent: category required');
		const c = this.columns;
		const framework: Array<[PacingField, unknown]> = [
			['whatsapp', whatsapp],
			['category', category],
			['tenantId', this.tenantId],
		];
		const cols: Array<ReturnType<typeof sql>> = [];
		const vals: Array<unknown> = [];
		for (const [field, value] of framework) {
			if (this.omitColumns.has(field)) continue;
			cols.push(sql.raw(c[field]));
			vals.push(value);
		}
		if (opts.extraColumns) {
			for (const [name, value] of Object.entries(opts.extraColumns)) {
				if (!this.allowedExtraColumns.has(name)) {
					throw new Error(`BotSendPacing.recordSent: extraColumns.${name} is not in allowedExtraColumns`);
				}
				cols.push(sql.raw(name));
				vals.push(value);
			}
		}
		await this.db.run(sql`
			INSERT INTO ${sql.raw(this.tableName)} (${sql.join(cols, sql`, `)})
			VALUES (${sql.join(vals.map((v) => sql`${v}`), sql`, `)})`);
	}

	/**
	 * @returns true when both configured gates pass. Returns true (allow)
	 * when no gates are configured — the primitive defaults to permissive
	 * so callers explicitly opt into each protection.
	 *
	 * On D1 error, returns true (fail-open). Pacing is a UX-quality concern,
	 * not a safety boundary; a query failure shouldn't block all cron sends.
	 */
	async canSend(whatsapp: string, opts: CanSendOptions = {}): Promise<boolean> {
		if (!whatsapp) return false;
		const minGap = opts.minGapMinutes ?? 60;
		const dailyCap = opts.dailyCap ?? null;
		try {
			if (minGap && minGap > 0) {
				const recent = await this.countSentSince(whatsapp, minGap);
				if (recent > 0) return false;
			}
			if (dailyCap !== null) {
				const sent = await this.countSentToday(whatsapp, opts.category);
				if (sent >= dailyCap) return false;
			}
			return true;
		} catch (e) {
			console.error('[BotSendPacing] canSend:', e instanceof Error ? e.message : e);
			return true;
		}
	}

	/**
	 * Count of sends today (UTC date), optionally scoped to a category.
	 * Used by the daily-cap check and exposed for dashboards.
	 */
	async countSentToday(whatsapp: string, category?: string): Promise<number> {
		const c = this.columns;
		const filters = [
			sql`${sql.raw(c.whatsapp)} = ${whatsapp}`,
			sql`${sql.raw(c.date)} = date('now')`,
		];
		if (category) filters.push(sql`${sql.raw(c.category)} = ${category}`);
		if (this.tenantId !== null && !this.omitColumns.has('tenantId')) {
			filters.push(sql`${sql.raw(c.tenantId)} = ${this.tenantId}`);
		}
		const rows = await this.db.all<{ n: number }>(sql`
			SELECT COUNT(*) AS n FROM ${sql.raw(this.tableName)}
			WHERE ${sql.join(filters, sql` AND `)}`);
		return rows[0]?.n ?? 0;
	}

	/** Map of category → today's send count for a user. */
	async countByCategoryToday(whatsapp: string): Promise<Record<string, number>> {
		const c = this.columns;
		const filters = [
			sql`${sql.raw(c.whatsapp)} = ${whatsapp}`,
			sql`${sql.raw(c.date)} = date('now')`,
		];
		if (this.tenantId !== null && !this.omitColumns.has('tenantId')) {
			filters.push(sql`${sql.raw(c.tenantId)} = ${this.tenantId}`);
		}
		const rows = await this.db.all<{ category: string; n: number }>(sql`
			SELECT ${sql.raw(c.category)} AS category, COUNT(*) AS n
			FROM ${sql.raw(this.tableName)}
			WHERE ${sql.join(filters, sql` AND `)}
			GROUP BY ${sql.raw(c.category)}`);
		const out: Record<string, number> = {};
		for (const r of rows) out[r.category] = r.n;
		return out;
	}

	/**
	 * Internal: how many sends to `whatsapp` in the last N minutes.
	 * Drives the min-gap check; exposed so apps can use it directly for
	 * custom predicates.
	 */
	async countSentSince(whatsapp: string, minutes: number): Promise<number> {
		const c = this.columns;
		const filters = [
			sql`${sql.raw(c.whatsapp)} = ${whatsapp}`,
			sql`${sql.raw(c.sentAt)} > datetime('now', '-' || ${minutes} || ' minutes')`,
		];
		if (this.tenantId !== null && !this.omitColumns.has('tenantId')) {
			filters.push(sql`${sql.raw(c.tenantId)} = ${this.tenantId}`);
		}
		const rows = await this.db.all<{ n: number }>(sql`
			SELECT COUNT(*) AS n FROM ${sql.raw(this.tableName)}
			WHERE ${sql.join(filters, sql` AND `)}`);
		return rows[0]?.n ?? 0;
	}
}
