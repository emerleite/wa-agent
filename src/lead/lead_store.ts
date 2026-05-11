/**
 * User profile + opt-in tracking.
 *
 * From v0.2 onward: backed by Drizzle ORM.
 */
import { eq, sql } from 'drizzle-orm';
import type { DB } from '../db/client.js';
import { leads, type Lead } from '../db/schema/leads.js';

const DEFAULT_FUNNEL = ['NEW', 'ONBOARDING', 'QUIZ', 'CHECKOUT', 'SUBSCRIBE'];

export interface LeadStoreOptions {
	db: DB;
	funnelStates?: string[];
}

export interface UpsertArgs {
	whatsapp: string;
	ctwaClid?: string | null;
	adData?: unknown;
	funnelState?: string;
}

export class LeadStore {
	readonly db: DB;
	readonly funnelStates: string[];

	constructor({ db, funnelStates = DEFAULT_FUNNEL }: LeadStoreOptions) {
		if (!db) throw new Error('LeadStore: db required');
		this.db = db;
		this.funnelStates = funnelStates;
	}

	async get(whatsapp: string): Promise<Lead | null> {
		const r = await this.db.select().from(leads).where(eq(leads.whatsapp, whatsapp)).limit(1);
		return r[0] ?? null;
	}

	async exists(whatsapp: string): Promise<boolean> {
		return !!(await this.get(whatsapp));
	}

	async upsert({ whatsapp, ctwaClid = null, adData = null, funnelState = 'NEW' }: UpsertArgs): Promise<boolean> {
		try {
			await this.db
				.insert(leads)
				.values({
					whatsapp,
					ctwaClid: ctwaClid || `${Date.now()}::${whatsapp}`,
					adData: JSON.stringify(adData ?? { whatsapp }),
					funnelState,
				})
				.onConflictDoNothing({ target: leads.whatsapp });
			return true;
		} catch (e) {
			console.error('[LeadStore] upsert:', e instanceof Error ? e.message : e);
			return false;
		}
	}

	async optIn(whatsapp: string): Promise<void> {
		await this.db
			.update(leads)
			.set({ optIn: 1, optInDate: sql`(datetime('now'))`, optOutDate: null })
			.where(eq(leads.whatsapp, whatsapp));
	}

	async optOut(whatsapp: string): Promise<void> {
		await this.db
			.update(leads)
			.set({ optIn: 0, optOutDate: sql`(datetime('now'))` })
			.where(eq(leads.whatsapp, whatsapp));
	}

	async isOptIn(whatsapp: string): Promise<boolean> {
		const r = await this.db.select({ optIn: leads.optIn }).from(leads).where(eq(leads.whatsapp, whatsapp)).limit(1);
		return !!r[0]?.optIn;
	}

	async setFunnelState(whatsapp: string, state: string): Promise<void> {
		if (!this.funnelStates.includes(state)) {
			throw new Error(`LeadStore: unknown funnel state "${state}". Allowed: ${this.funnelStates.join(', ')}`);
		}
		await this.db.update(leads).set({ funnelState: state }).where(eq(leads.whatsapp, whatsapp));
	}
}
