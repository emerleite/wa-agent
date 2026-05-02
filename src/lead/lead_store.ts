/**
 * User profile + opt-in tracking.
 */
const DEFAULT_FUNNEL = ['NEW', 'ONBOARDING', 'QUIZ', 'CHECKOUT', 'SUBSCRIBE'];

export interface LeadStoreOptions {
	db: D1Database;
	table?: string;
	funnelStates?: string[];
}

export interface LeadRow {
	id: number;
	ctwa_clid: string | null;
	whatsapp: string;
	ad_data: string;
	created_at: string;
	funnel_state: string;
	opt_in: number;
	opt_in_date: string | null;
	opt_out_date: string | null;
}

export interface UpsertArgs {
	whatsapp: string;
	ctwaClid?: string | null;
	adData?: unknown;
	funnelState?: string;
}

export class LeadStore {
	readonly db: D1Database;
	readonly table: string;
	readonly funnelStates: string[];

	constructor({ db, table = 'leads', funnelStates = DEFAULT_FUNNEL }: LeadStoreOptions) {
		if (!db) throw new Error('LeadStore: db required');
		this.db = db;
		this.table = table;
		this.funnelStates = funnelStates;
	}

	async get(whatsapp: string): Promise<LeadRow | null> {
		return await this.db.prepare(`SELECT * FROM ${this.table} WHERE whatsapp = ?`).bind(whatsapp).first<LeadRow>();
	}

	async exists(whatsapp: string): Promise<boolean> {
		return !!(await this.get(whatsapp));
	}

	async upsert({ whatsapp, ctwaClid = null, adData = null, funnelState = 'NEW' }: UpsertArgs): Promise<boolean> {
		try {
			const r = await this.db
				.prepare(
					`INSERT INTO ${this.table} (ctwa_clid, whatsapp, ad_data, funnel_state)
					 VALUES (?, ?, ?, ?)
					 ON CONFLICT(whatsapp) DO NOTHING`
				)
				.bind(ctwaClid || `${Date.now()}::${whatsapp}`, whatsapp, JSON.stringify(adData ?? { whatsapp }), funnelState)
				.run();
			return r.success;
		} catch (e) {
			console.error('[LeadStore] upsert:', e instanceof Error ? e.message : e);
			return false;
		}
	}

	async optIn(whatsapp: string): Promise<void> {
		await this.db
			.prepare(`UPDATE ${this.table} SET opt_in = 1, opt_in_date = datetime('now'), opt_out_date = NULL WHERE whatsapp = ?`)
			.bind(whatsapp)
			.run();
	}

	async optOut(whatsapp: string): Promise<void> {
		await this.db
			.prepare(`UPDATE ${this.table} SET opt_in = 0, opt_out_date = datetime('now') WHERE whatsapp = ?`)
			.bind(whatsapp)
			.run();
	}

	async isOptIn(whatsapp: string): Promise<boolean> {
		const row = await this.db.prepare(`SELECT opt_in FROM ${this.table} WHERE whatsapp = ?`).bind(whatsapp).first<{ opt_in: number }>();
		return !!row?.opt_in;
	}

	async setFunnelState(whatsapp: string, state: string): Promise<void> {
		if (!this.funnelStates.includes(state)) {
			throw new Error(`LeadStore: unknown funnel state "${state}". Allowed: ${this.funnelStates.join(', ')}`);
		}
		await this.db.prepare(`UPDATE ${this.table} SET funnel_state = ? WHERE whatsapp = ?`).bind(state, whatsapp).run();
	}
}
