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
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import type { DB } from '../db/client.js';
import { escalations, type EscalationRow } from '../db/schema/escalations.js';

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
	whatsapp: string;
	reason: EscalationReason;
	urgency: EscalationUrgency;
	message: string;
	traceId?: string | null;
	tenantId?: string | null;
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

export interface EscalationStoreOptions {
	db: DB;
	/** Optional sink for newly-recorded escalations. Default: NoOpNotifier. */
	notifier?: EscalationNotifier | null;
	/**
	 * Minimum urgency that triggers the notifier. Below this, only D1 is
	 * touched. Default 'medium' — `low` escalations are recorded silently.
	 */
	notifyAtOrAbove?: EscalationUrgency;
}

const URGENCY_RANK: Record<EscalationUrgency, number> = {
	low: 0,
	medium: 1,
	high: 2,
	critical: 3,
};

export class EscalationStore {
	readonly db: DB;
	readonly notifier: EscalationNotifier;
	readonly notifyAtOrAbove: EscalationUrgency;

	constructor({ db, notifier = null, notifyAtOrAbove = 'medium' }: EscalationStoreOptions) {
		if (!db) throw new Error('EscalationStore: db required');
		this.db = db;
		this.notifier = notifier ?? new NoOpNotifier();
		this.notifyAtOrAbove = notifyAtOrAbove;
	}

	/**
	 * Insert a row, fire the notifier asynchronously, return the new id.
	 * Failure to notify never blocks the record path — notifier errors are
	 * caught + logged so a downstream outage can't break escalation logging.
	 */
	async record(args: EscalateArgs): Promise<string> {
		if (!args.whatsapp) throw new Error('EscalationStore.record: whatsapp required');
		if (!args.reason) throw new Error('EscalationStore.record: reason required');
		if (!args.message) throw new Error('EscalationStore.record: message required');

		const id = crypto.randomUUID();
		await this.db.insert(escalations).values({
			id,
			whatsapp: args.whatsapp,
			reason: args.reason,
			urgency: args.urgency,
			message: args.message,
			traceId: args.traceId ?? null,
			tenantId: args.tenantId ?? null,
		});

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
		const rows = await this.db.select().from(escalations).where(eq(escalations.id, id)).limit(1);
		return rows[0] ?? null;
	}

	async resolve(id: string, args: ResolveArgs = {}): Promise<boolean> {
		const r = await this.db
			.update(escalations)
			.set({
				resolvedAt: sql`(datetime('now'))`,
				resolvedBy: args.resolvedBy ?? null,
				notes: args.notes ?? null,
			})
			.where(and(eq(escalations.id, id), isNull(escalations.resolvedAt)))
			.returning({ id: escalations.id });
		return r.length > 0;
	}

	async list({ activeOnly = true, urgency, tenantId, whatsapp, limit = 100 }: ListEscalationsOptions = {}): Promise<EscalationRow[]> {
		const where = and(
			activeOnly ? isNull(escalations.resolvedAt) : undefined,
			urgency ? eq(escalations.urgency, urgency) : undefined,
			tenantId ? eq(escalations.tenantId, tenantId) : undefined,
			whatsapp ? eq(escalations.whatsapp, whatsapp) : undefined,
		);
		return await this.db.select().from(escalations).where(where).orderBy(desc(escalations.createdAt)).limit(limit);
	}

	/** Number of currently open escalations, optionally filtered by urgency. */
	async openCount({ urgency, tenantId }: { urgency?: EscalationUrgency; tenantId?: string } = {}): Promise<number> {
		const rows = await this.db
			.select({ id: escalations.id })
			.from(escalations)
			.where(
				and(
					isNull(escalations.resolvedAt),
					urgency ? eq(escalations.urgency, urgency) : undefined,
					tenantId ? eq(escalations.tenantId, tenantId) : undefined,
				),
			);
		return rows.length;
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
