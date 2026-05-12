/**
 * Sequential, multi-day content plans (drip campaigns, reading plans).
 *
 * From v0.2 onward: backed by Drizzle ORM.
 */
import { and, asc, eq, isNull, lt, or, sql } from 'drizzle-orm';
import type { DB } from '../db/client.js';
import { plans as plansTable, planDays, userPlans, userPlanProgress, type Plan, type PlanDay, type UserPlan } from '../db/schema/plans.js';
import { messageWindows } from '../db/schema/message_windows.js';
import { leads } from '../db/schema/leads.js';

export interface SequentialPlanOptions {
	db: DB;
}

export type PlanRow = Plan;
export type DayRow = PlanDay;

/**
 * Enrollment row enriched with plan title / slug / duration when read via
 * `getActiveEnrollment`. Bare `select().from(userPlans)` returns just UserPlan.
 */
export interface UserPlanRow extends UserPlan {
	title?: string;
	slug?: string;
	durationDays?: number;
}

export interface DeliveryUser {
	whatsapp: string;
	planId: number;
	currentDay: number;
	title: string;
	durationDays: number;
}

export type AdvanceResult = { completed: true; day: number } | { completed: false; nextDay: number };

export class SequentialPlan {
	readonly db: DB;

	constructor({ db }: SequentialPlanOptions) {
		if (!db) throw new Error('SequentialPlan: db required');
		this.db = db;
	}

	async listActivePlans(): Promise<PlanRow[]> {
		return await this.db.select().from(plansTable).where(eq(plansTable.isActive, 1)).orderBy(asc(plansTable.durationDays));
	}

	async getPlanById(id: number): Promise<PlanRow | null> {
		const r = await this.db.select().from(plansTable).where(eq(plansTable.id, id)).limit(1);
		return r[0] ?? null;
	}

	async getPlanBySlug(slug: string): Promise<PlanRow | null> {
		const r = await this.db.select().from(plansTable).where(eq(plansTable.slug, slug)).limit(1);
		return r[0] ?? null;
	}

	async getDay(planId: number, day: number): Promise<DayRow | null> {
		const r = await this.db.select().from(planDays).where(and(eq(planDays.planId, planId), eq(planDays.day, day))).limit(1);
		return r[0] ?? null;
	}

	async enroll(whatsapp: string, planId: number): Promise<boolean> {
		// Deactivate other active enrollments for this user, then upsert the new one.
		await this.db.update(userPlans).set({ isActive: 0 }).where(and(eq(userPlans.whatsapp, whatsapp), eq(userPlans.isActive, 1)));
		await this.db
			.insert(userPlans)
			.values({ whatsapp, planId, currentDay: 1, isActive: 1 })
			.onConflictDoUpdate({
				target: [userPlans.whatsapp, userPlans.planId],
				set: { currentDay: 1, isActive: 1, startedAt: sql`(datetime('now'))`, completedAt: null },
			});
		return true;
	}

	async unenroll(whatsapp: string): Promise<void> {
		await this.db.update(userPlans).set({ isActive: 0 }).where(and(eq(userPlans.whatsapp, whatsapp), eq(userPlans.isActive, 1)));
	}

	async getActiveEnrollment(whatsapp: string): Promise<UserPlanRow | null> {
		const r = await this.db
			.select({
				id: userPlans.id,
				whatsapp: userPlans.whatsapp,
				planId: userPlans.planId,
				currentDay: userPlans.currentDay,
				startedAt: userPlans.startedAt,
				completedAt: userPlans.completedAt,
				isActive: userPlans.isActive,
				lastDeliveredAt: userPlans.lastDeliveredAt,
				title: plansTable.title,
				slug: plansTable.slug,
				durationDays: plansTable.durationDays,
			})
			.from(userPlans)
			.innerJoin(plansTable, eq(plansTable.id, userPlans.planId))
			.where(and(eq(userPlans.whatsapp, whatsapp), eq(userPlans.isActive, 1)))
			.limit(1);
		return r[0] ?? null;
	}

	async markDone(whatsapp: string, planId: number, day: number): Promise<AdvanceResult> {
		await this.db
			.insert(userPlanProgress)
			.values({ whatsapp, planId, day })
			.onConflictDoNothing({ target: [userPlanProgress.whatsapp, userPlanProgress.planId, userPlanProgress.day] });
		return await this.advance(whatsapp, planId, day);
	}

	async skipDay(whatsapp: string, planId: number, day: number): Promise<AdvanceResult> {
		return await this.advance(whatsapp, planId, day);
	}

	private async advance(whatsapp: string, planId: number, fromDay: number): Promise<AdvanceResult> {
		const plan = await this.getPlanById(planId);
		if (!plan) return { completed: true, day: fromDay };
		const next = fromDay + 1;
		if (next > plan.durationDays) {
			await this.db
				.update(userPlans)
				.set({ isActive: 0, completedAt: sql`(datetime('now'))`, currentDay: fromDay })
				.where(and(eq(userPlans.whatsapp, whatsapp), eq(userPlans.planId, planId)));
			return { completed: true, day: fromDay };
		}
		await this.db
			.update(userPlans)
			.set({ currentDay: next })
			.where(and(eq(userPlans.whatsapp, whatsapp), eq(userPlans.planId, planId)));
		return { completed: false, nextDay: next };
	}

	async autoAdvanceStale({ staleHours = 24 }: { staleHours?: number } = {}): Promise<number> {
		const stale = await this.db
			.select({
				whatsapp: userPlans.whatsapp,
				planId: userPlans.planId,
				currentDay: userPlans.currentDay,
				durationDays: plansTable.durationDays,
			})
			.from(userPlans)
			.innerJoin(plansTable, eq(plansTable.id, userPlans.planId))
			.innerJoin(
				userPlanProgress,
				and(
					eq(userPlanProgress.whatsapp, userPlans.whatsapp),
					eq(userPlanProgress.planId, userPlans.planId),
					eq(userPlanProgress.day, userPlans.currentDay)
				)
			)
			.where(
				and(
					eq(userPlans.isActive, 1),
					lt(userPlanProgress.completedAt, sql.raw(`(datetime('now', '-${staleHours} hours'))`))
				)
			);

		for (const s of stale) {
			await this.skipDay(s.whatsapp, s.planId, s.currentDay);
		}
		return stale.length;
	}

	/**
	 * Cron audience: users due for the next day's delivery.
	 *
	 * Gates: active enrollment, opt-in lead, open Meta message window, and
	 * `last_delivered_at` either NULL or older than `minIntervalHours` (default 20h).
	 */
	async usersForDelivery({ limit = 500, minIntervalHours = 20 }: { limit?: number; minIntervalHours?: number } = {}): Promise<DeliveryUser[]> {
		const intervalExpr = sql.raw(`(datetime('now', '-${minIntervalHours} hours'))`);
		return await this.db
			.select({
				whatsapp: userPlans.whatsapp,
				planId: userPlans.planId,
				currentDay: userPlans.currentDay,
				title: plansTable.title,
				durationDays: plansTable.durationDays,
			})
			.from(userPlans)
			.innerJoin(plansTable, eq(plansTable.id, userPlans.planId))
			.innerJoin(messageWindows, and(eq(messageWindows.whatsapp, userPlans.whatsapp), sql`${messageWindows.endTime} > datetime('now')`))
			.innerJoin(leads, and(eq(leads.whatsapp, userPlans.whatsapp), eq(leads.optIn, 1)))
			.where(and(eq(userPlans.isActive, 1), or(isNull(userPlans.lastDeliveredAt), lt(userPlans.lastDeliveredAt, intervalExpr))))
			.limit(limit);
	}

	/**
	 * Record a successful delivery for cadence + analytics.
	 *
	 * Writes the progress row (idempotent) AND bumps `user_plans.last_delivered_at`
	 * to NOW so `usersForDelivery` won't redeliver until at least `minIntervalHours`
	 * later.
	 */
	async markDelivered(whatsapp: string, planId: number, day: number): Promise<void> {
		try {
			await this.db.batch([
				this.db
					.insert(userPlanProgress)
					.values({ whatsapp, planId, day })
					.onConflictDoNothing({ target: [userPlanProgress.whatsapp, userPlanProgress.planId, userPlanProgress.day] }),
				this.db
					.update(userPlans)
					.set({ lastDeliveredAt: sql`(datetime('now'))` })
					.where(and(eq(userPlans.whatsapp, whatsapp), eq(userPlans.planId, planId))),
			]);
		} catch (e) {
			console.error('[SequentialPlan] markDelivered:', e instanceof Error ? e.message : e);
		}
	}
}
