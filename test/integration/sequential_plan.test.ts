import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { SequentialPlan } from '../../src/content/sequential_plan.js';

const db = (env as { DB: D1Database }).DB;

beforeAll(async () => {
	await db.prepare('DELETE FROM plans').run();
	await db.prepare('DELETE FROM plan_days').run();
	await db
		.prepare("INSERT INTO plans (id, slug, title, description, duration_days) VALUES (1, '21-day', '21-day plan', 'demo', 21)")
		.run();
	for (let d = 1; d <= 21; d++) {
		await db.prepare('INSERT INTO plan_days (plan_id, day, title, content) VALUES (?, ?, ?, ?)').bind(1, d, `Day ${d}`, `content ${d}`).run();
	}
});

beforeEach(async () => {
	await db.prepare('DELETE FROM user_plans').run();
	await db.prepare('DELETE FROM user_plan_progress').run();
});

describe('SequentialPlan', () => {
	const plans = new SequentialPlan({ db });

	it('lists active plans', async () => {
		const r = await plans.listActivePlans();
		expect(r.length).toBeGreaterThan(0);
		expect(r[0]?.slug).toBe('21-day');
	});

	it('enroll creates an active enrollment at day 1', async () => {
		await plans.enroll('5551', 1);
		const e = await plans.getActiveEnrollment('5551');
		expect(e?.current_day).toBe(1);
		expect(e?.is_active).toBe(1);
	});

	it('enrolling in a different plan deactivates the previous one', async () => {
		await plans.enroll('5551', 1);
		// "Enroll" again in same plan resets to day 1
		await plans.enroll('5551', 1);
		const e = await plans.getActiveEnrollment('5551');
		expect(e?.current_day).toBe(1);
	});

	it('markDone advances to next day', async () => {
		await plans.enroll('5551', 1);
		const r = await plans.markDone('5551', 1, 1);
		expect(r).toEqual({ completed: false, nextDay: 2 });
		const e = await plans.getActiveEnrollment('5551');
		expect(e?.current_day).toBe(2);
	});

	it('markDone on final day completes the plan', async () => {
		await plans.enroll('5551', 1);
		// Skip ahead to day 21
		await db.prepare('UPDATE user_plans SET current_day = 21 WHERE whatsapp = ?').bind('5551').run();
		const r = await plans.markDone('5551', 1, 21);
		expect(r).toEqual({ completed: true, day: 21 });
		const e = await plans.getActiveEnrollment('5551');
		expect(e).toBeNull(); // no longer active
	});

	it('skipDay advances without recording progress', async () => {
		await plans.enroll('5551', 1);
		const r = await plans.skipDay('5551', 1, 1);
		expect(r).toEqual({ completed: false, nextDay: 2 });

		const progress = await db
			.prepare("SELECT * FROM user_plan_progress WHERE whatsapp = '5551'")
			.first();
		expect(progress).toBeNull();
	});

	it('autoAdvanceStale skips users with progress >24h old', async () => {
		await plans.enroll('5551', 1);
		await plans.markDelivered('5551', 1, 1);
		// Backdate the progress row to 25h ago
		await db.prepare(`UPDATE user_plan_progress SET completed_at = datetime('now', '-25 hours') WHERE whatsapp = '5551'`).run();

		const advanced = await plans.autoAdvanceStale();
		expect(advanced).toBe(1);
		const e = await plans.getActiveEnrollment('5551');
		expect(e?.current_day).toBe(2);
	});
});
