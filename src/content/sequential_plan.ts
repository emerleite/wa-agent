/**
 * Sequential, multi-day content plans (drip campaigns, reading plans).
 */
export interface SequentialPlanOptions {
	db: D1Database;
	planTable?: string;
	dayTable?: string;
	userPlanTable?: string;
	progressTable?: string;
}

export interface PlanRow {
	id: number;
	slug: string;
	title: string;
	description: string | null;
	duration_days: number;
	is_active: number;
}

export interface DayRow {
	id: number;
	plan_id: number;
	day: number;
	title: string;
	content: string;
	extra_json: string | null;
}

export interface UserPlanRow {
	id: number;
	whatsapp: string;
	plan_id: number;
	current_day: number;
	started_at: string;
	completed_at: string | null;
	is_active: number;
	title?: string;
	slug?: string;
	duration_days?: number;
}

export interface DeliveryUser {
	whatsapp: string;
	plan_id: number;
	current_day: number;
	title: string;
	duration_days: number;
}

export type AdvanceResult = { completed: true; day: number } | { completed: false; nextDay: number };

export class SequentialPlan {
	readonly db: D1Database;
	readonly planTable: string;
	readonly dayTable: string;
	readonly userPlanTable: string;
	readonly progressTable: string;

	constructor({
		db,
		planTable = 'plans',
		dayTable = 'plan_days',
		userPlanTable = 'user_plans',
		progressTable = 'user_plan_progress',
	}: SequentialPlanOptions) {
		if (!db) throw new Error('SequentialPlan: db required');
		this.db = db;
		this.planTable = planTable;
		this.dayTable = dayTable;
		this.userPlanTable = userPlanTable;
		this.progressTable = progressTable;
	}

	async listActivePlans(): Promise<PlanRow[]> {
		const r = await this.db.prepare(`SELECT * FROM ${this.planTable} WHERE is_active = 1 ORDER BY duration_days ASC`).all<PlanRow>();
		return r.results ?? [];
	}

	async getPlanById(id: number): Promise<PlanRow | null> {
		return await this.db.prepare(`SELECT * FROM ${this.planTable} WHERE id = ?`).bind(id).first<PlanRow>();
	}

	async getPlanBySlug(slug: string): Promise<PlanRow | null> {
		return await this.db.prepare(`SELECT * FROM ${this.planTable} WHERE slug = ?`).bind(slug).first<PlanRow>();
	}

	async getDay(planId: number, day: number): Promise<DayRow | null> {
		return await this.db.prepare(`SELECT * FROM ${this.dayTable} WHERE plan_id = ? AND day = ?`).bind(planId, day).first<DayRow>();
	}

	async enroll(whatsapp: string, planId: number): Promise<boolean> {
		await this.db
			.prepare(`UPDATE ${this.userPlanTable} SET is_active = 0 WHERE whatsapp = ? AND is_active = 1`)
			.bind(whatsapp)
			.run();
		await this.db
			.prepare(
				`INSERT INTO ${this.userPlanTable} (whatsapp, plan_id, current_day, is_active)
				 VALUES (?, ?, 1, 1)
				 ON CONFLICT(whatsapp, plan_id) DO UPDATE SET
				   current_day = 1, is_active = 1, started_at = datetime('now'), completed_at = NULL`
			)
			.bind(whatsapp, planId)
			.run();
		return true;
	}

	async unenroll(whatsapp: string): Promise<void> {
		await this.db
			.prepare(`UPDATE ${this.userPlanTable} SET is_active = 0 WHERE whatsapp = ? AND is_active = 1`)
			.bind(whatsapp)
			.run();
	}

	async getActiveEnrollment(whatsapp: string): Promise<UserPlanRow | null> {
		return await this.db
			.prepare(
				`SELECT up.*, p.title, p.slug, p.duration_days
				 FROM ${this.userPlanTable} up
				 JOIN ${this.planTable} p ON p.id = up.plan_id
				 WHERE up.whatsapp = ? AND up.is_active = 1`
			)
			.bind(whatsapp)
			.first<UserPlanRow>();
	}

	async markDone(whatsapp: string, planId: number, day: number): Promise<AdvanceResult> {
		await this.db
			.prepare(`INSERT OR IGNORE INTO ${this.progressTable} (whatsapp, plan_id, day) VALUES (?, ?, ?)`)
			.bind(whatsapp, planId, day)
			.run();
		return await this.advance(whatsapp, planId, day);
	}

	async skipDay(whatsapp: string, planId: number, day: number): Promise<AdvanceResult> {
		return await this.advance(whatsapp, planId, day);
	}

	private async advance(whatsapp: string, planId: number, fromDay: number): Promise<AdvanceResult> {
		const plan = await this.getPlanById(planId);
		if (!plan) return { completed: true, day: fromDay };
		const next = fromDay + 1;
		if (next > plan.duration_days) {
			await this.db
				.prepare(
					`UPDATE ${this.userPlanTable}
					 SET is_active = 0, completed_at = datetime('now'), current_day = ?
					 WHERE whatsapp = ? AND plan_id = ?`
				)
				.bind(fromDay, whatsapp, planId)
				.run();
			return { completed: true, day: fromDay };
		}
		await this.db
			.prepare(`UPDATE ${this.userPlanTable} SET current_day = ? WHERE whatsapp = ? AND plan_id = ?`)
			.bind(next, whatsapp, planId)
			.run();
		return { completed: false, nextDay: next };
	}

	async autoAdvanceStale({ staleHours = 24 }: { staleHours?: number } = {}): Promise<number> {
		const r = await this.db
			.prepare(
				`SELECT up.whatsapp, up.plan_id, up.current_day, p.duration_days
				 FROM ${this.userPlanTable} up
				 JOIN ${this.planTable} p ON p.id = up.plan_id
				 JOIN ${this.progressTable} pp
					 ON pp.whatsapp = up.whatsapp AND pp.plan_id = up.plan_id AND pp.day = up.current_day
				 WHERE up.is_active = 1
					 AND pp.completed_at < datetime('now', '-${staleHours} hours')`
			)
			.all<{ whatsapp: string; plan_id: number; current_day: number; duration_days: number }>();

		const stale = r.results ?? [];
		for (const s of stale) {
			await this.skipDay(s.whatsapp, s.plan_id, s.current_day);
		}
		return stale.length;
	}

	async usersForDelivery({ limit = 500 }: { limit?: number } = {}): Promise<DeliveryUser[]> {
		const r = await this.db
			.prepare(
				`SELECT up.whatsapp, up.plan_id, up.current_day, p.title, p.duration_days
				 FROM ${this.userPlanTable} up
				 JOIN ${this.planTable} p ON p.id = up.plan_id
				 JOIN message_windows mw ON mw.whatsapp = up.whatsapp AND mw.end_time > datetime('now')
				 JOIN leads l ON l.whatsapp = up.whatsapp AND l.opt_in = 1
				 WHERE up.is_active = 1
				   AND NOT EXISTS (
					   SELECT 1 FROM ${this.progressTable} pp
					   WHERE pp.whatsapp = up.whatsapp AND pp.plan_id = up.plan_id
					     AND date(pp.completed_at) = date('now')
				   )
				 LIMIT ?`
			)
			.bind(limit)
			.all<DeliveryUser>();
		return r.results ?? [];
	}

	async markDelivered(whatsapp: string, planId: number, day: number): Promise<void> {
		try {
			await this.db
				.prepare(`INSERT OR IGNORE INTO ${this.progressTable} (whatsapp, plan_id, day) VALUES (?, ?, ?)`)
				.bind(whatsapp, planId, day)
				.run();
		} catch (e) {
			console.error('[SequentialPlan] markDelivered:', e instanceof Error ? e.message : e);
		}
	}
}
