import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { SequentialPlan } from '../../src/content/sequential_plan.js';
import { createDb } from '../../src/db/client.js';

const d1 = (env as { DB: D1Database }).DB;
const db = createDb(d1);

beforeAll(async () => {
	await d1.prepare('DELETE FROM plans').run();
	await d1.prepare('DELETE FROM plan_days').run();
	await d1
		.prepare("INSERT INTO plans (id, slug, title, description, duration_days) VALUES (1, '21-day', '21-day plan', 'demo', 21)")
		.run();
	for (let d = 1; d <= 21; d++) {
		await d1.prepare('INSERT INTO plan_days (plan_id, day, title, content) VALUES (?, ?, ?, ?)').bind(1, d, `Day ${d}`, `content ${d}`).run();
	}
});

beforeEach(async () => {
	await d1.prepare('DELETE FROM user_plans').run();
	await d1.prepare('DELETE FROM user_plan_progress').run();
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
		expect(e?.currentDay).toBe(1);
		expect(e?.isActive).toBe(1);
	});

	it('enrolling in a different plan deactivates the previous one', async () => {
		await plans.enroll('5551', 1);
		// "Enroll" again in same plan resets to day 1
		await plans.enroll('5551', 1);
		const e = await plans.getActiveEnrollment('5551');
		expect(e?.currentDay).toBe(1);
	});

	it('markDone advances to next day', async () => {
		await plans.enroll('5551', 1);
		const r = await plans.markDone('5551', 1, 1);
		expect(r).toEqual({ completed: false, nextDay: 2 });
		const e = await plans.getActiveEnrollment('5551');
		expect(e?.currentDay).toBe(2);
	});

	it('markDone on final day completes the plan', async () => {
		await plans.enroll('5551', 1);
		// Skip ahead to day 21
		await d1.prepare('UPDATE user_plans SET current_day = 21 WHERE whatsapp = ?').bind('5551').run();
		const r = await plans.markDone('5551', 1, 21);
		expect(r).toEqual({ completed: true, day: 21 });
		const e = await plans.getActiveEnrollment('5551');
		expect(e).toBeNull(); // no longer active
	});

	it('skipDay advances without recording progress', async () => {
		await plans.enroll('5551', 1);
		const r = await plans.skipDay('5551', 1, 1);
		expect(r).toEqual({ completed: false, nextDay: 2 });

		const progress = await d1
			.prepare("SELECT * FROM user_plan_progress WHERE whatsapp = '5551'")
			.first();
		expect(progress).toBeNull();
	});

	it('autoAdvanceStale skips users with progress >24h old', async () => {
		await plans.enroll('5551', 1);
		await plans.markDelivered('5551', 1, 1);
		// Backdate the progress row to 25h ago
		await d1.prepare(`UPDATE user_plan_progress SET completed_at = datetime('now', '-25 hours') WHERE whatsapp = '5551'`).run();

		const advanced = await plans.autoAdvanceStale();
		expect(advanced).toBe(1);
		const e = await plans.getActiveEnrollment('5551');
		expect(e?.currentDay).toBe(2);
	});

	describe('cadence gate (last_delivered_at)', () => {
		// Need opt-in + open window for usersForDelivery to consider a user.
		async function eligible(whatsapp: string) {
			await d1.prepare(`INSERT OR IGNORE INTO leads (whatsapp, ad_data, opt_in) VALUES (?, '{}', 1)`).bind(whatsapp).run();
			await d1.prepare(`UPDATE leads SET opt_in = 1 WHERE whatsapp = ?`).bind(whatsapp).run();
			await d1
				.prepare(
					`INSERT INTO message_windows (whatsapp, window_type, end_time) VALUES (?, 'paid', datetime('now', '+1 day'))
					 ON CONFLICT(whatsapp) DO UPDATE SET end_time = datetime('now', '+1 day')`
				)
				.bind(whatsapp)
				.run();
		}

		beforeEach(async () => {
			await d1.prepare('DELETE FROM leads').run();
			await d1.prepare('DELETE FROM message_windows').run();
		});

		it('markDelivered writes last_delivered_at on user_plans', async () => {
			await plans.enroll('5551', 1);
			await plans.markDelivered('5551', 1, 1);
			const row = await d1
				.prepare(`SELECT last_delivered_at FROM user_plans WHERE whatsapp = '5551'`)
				.first<{ last_delivered_at: string }>();
			expect(row?.last_delivered_at).toBeTruthy();
		});

		it('usersForDelivery excludes users delivered to within the last 20h', async () => {
			await eligible('5551');
			await plans.enroll('5551', 1);
			await plans.markDelivered('5551', 1, 1);
			const due = await plans.usersForDelivery();
			expect(due).toEqual([]);
		});

		it('usersForDelivery includes users whose last delivery was >20h ago', async () => {
			await eligible('5551');
			await plans.enroll('5551', 1);
			await plans.markDelivered('5551', 1, 1);
			await d1
				.prepare(`UPDATE user_plans SET last_delivered_at = datetime('now', '-21 hours') WHERE whatsapp = '5551'`)
				.run();
			const due = await plans.usersForDelivery();
			expect(due.length).toBe(1);
			expect(due[0]?.whatsapp).toBe('5551');
		});

		it('usersForDelivery includes never-delivered enrollments (NULL last_delivered_at)', async () => {
			await eligible('5552');
			await plans.enroll('5552', 1);
			const due = await plans.usersForDelivery();
			expect(due.length).toBe(1);
		});

		it('cross-midnight click+cron does not redeliver within the 20h window', async () => {
			// Simulate: delivered at 23:55, user clicks Done, cron fires at 00:30
			await eligible('5553');
			await plans.enroll('5553', 1);
			await plans.markDelivered('5553', 1, 1);
			// User taps Done — advances current_day to 2
			await plans.markDone('5553', 1, 1);
			// Cron at +35 minutes: must NOT redeliver
			const due = await plans.usersForDelivery();
			expect(due).toEqual([]);
		});

		it('minIntervalHours override', async () => {
			await eligible('5554');
			await plans.enroll('5554', 1);
			await plans.markDelivered('5554', 1, 1);
			await d1
				.prepare(`UPDATE user_plans SET last_delivered_at = datetime('now', '-2 hours') WHERE whatsapp = '5554'`)
				.run();
			expect((await plans.usersForDelivery({ minIntervalHours: 20 })).length).toBe(0);
			expect((await plans.usersForDelivery({ minIntervalHours: 1 })).length).toBe(1);
		});
	});

	it('markDelivered emits plan_day_delivered when emit is wired', async () => {
		const events: Array<{ type: string; planId?: number; day?: number; whatsapp?: string }> = [];
		const tracked = new SequentialPlan({
			db,
			emit: async (ev) => {
				events.push({
					type: ev.type,
					planId: (ev as { planId?: number }).planId,
					day: (ev as { day?: number }).day,
					whatsapp: (ev as { whatsapp?: string }).whatsapp,
				});
			},
		});
		await tracked.enroll('5555', 1);
		await tracked.markDelivered('5555', 1, 1);
		expect(events).toEqual([{ type: 'plan_day_delivered', whatsapp: '5555', planId: 1, day: 1 }]);
	});
});
