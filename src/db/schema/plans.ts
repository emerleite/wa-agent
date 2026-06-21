/**
 * Sequential multi-day plans + per-user enrollment + progress.
 *
 * Schema mirrors migrations/005_plans.sql and migrations/009_plan_cadence.sql
 * (the latter added `last_delivered_at` to user_plans).
 */
import { sqliteTable, integer, text, index, unique } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';

export const plans = sqliteTable('plans', {
	id: integer('id').primaryKey({ autoIncrement: true }),
	slug: text('slug').unique().notNull(),
	title: text('title').notNull(),
	description: text('description'),
	durationDays: integer('duration_days').notNull(),
	isActive: integer('is_active').notNull().default(1),
	createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
});

export const planDays = sqliteTable(
	'plan_days',
	{
		id: integer('id').primaryKey({ autoIncrement: true }),
		planId: integer('plan_id')
			.notNull()
			.references(() => plans.id),
		day: integer('day').notNull(),
		title: text('title').notNull(),
		content: text('content').notNull(),
		extraJson: text('extra_json'),
	},
	(t) => [unique().on(t.planId, t.day)]
);

export const userPlans = sqliteTable(
	'user_plans',
	{
		id: integer('id').primaryKey({ autoIncrement: true }),
		whatsapp: text('whatsapp').notNull(),
		planId: integer('plan_id')
			.notNull()
			.references(() => plans.id),
		currentDay: integer('current_day').notNull().default(1),
		startedAt: text('started_at').notNull().default(sql`(datetime('now'))`),
		completedAt: text('completed_at'),
		isActive: integer('is_active').notNull().default(1),
		lastDeliveredAt: text('last_delivered_at'),
		snoozedUntil: text('snoozed_until'),
	},
	(t) => [
		unique().on(t.whatsapp, t.planId),
		index('idx_user_plans_whatsapp').on(t.whatsapp),
		index('idx_user_plans_active').on(t.isActive, t.whatsapp),
		index('idx_user_plans_plan_active').on(t.planId, t.isActive, t.completedAt),
		index('idx_user_plans_last_delivered').on(t.lastDeliveredAt),
		index('idx_user_plans_snoozed_until').on(t.snoozedUntil),
	]
);

export const userPlanProgress = sqliteTable(
	'user_plan_progress',
	{
		id: integer('id').primaryKey({ autoIncrement: true }),
		whatsapp: text('whatsapp').notNull(),
		planId: integer('plan_id').notNull(),
		day: integer('day').notNull(),
		completedAt: text('completed_at').notNull().default(sql`(datetime('now'))`),
	},
	(t) => [
		unique().on(t.whatsapp, t.planId, t.day),
		index('idx_upp_lookup').on(t.whatsapp, t.planId, t.day, t.completedAt),
	]
);

export type Plan = typeof plans.$inferSelect;
export type PlanDay = typeof planDays.$inferSelect;
export type UserPlan = typeof userPlans.$inferSelect;
export type UserPlanProgress = typeof userPlanProgress.$inferSelect;
