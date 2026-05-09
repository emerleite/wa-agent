/**
 * Integration tests for the data-loading dashboard cards. Each renders an
 * HTML fragment from real D1 — we assert that the rendered output reflects
 * what was seeded, not specific HTML structure.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { summaryCard, queueCard, funnelCard, messagesChartCard, dauCard, engagementCard, plansCard, churnCard } from '../../src/dashboard/index.js';

const db = (env as { DB: D1Database }).DB;

async function reset() {
	for (const t of ['leads', 'messages', 'message_windows', 'message_queue', 'engagement_answers', 'broadcast_log', 'plans', 'plan_days', 'user_plans']) {
		await db.prepare(`DELETE FROM ${t}`).run();
	}
}

beforeEach(reset);

describe('summaryCard', () => {
	it('renders KPI tiles from leads + messages + windows', async () => {
		await db.prepare(`INSERT INTO leads (whatsapp, ad_data, opt_in) VALUES ('5551', '{}', 1), ('5552', '{}', 0)`).run();
		await db.prepare(`INSERT INTO messages (wamid, whatsapp, type, payload) VALUES ('w1', '5551', 'text', '{}')`).run();
		await db.prepare(`INSERT INTO message_windows (whatsapp, window_type, end_time) VALUES ('5551', 'paid', datetime('now', '+1 hour'))`).run();

		const html = await summaryCard().render({ db, env: {}, query: {} });
		expect(html).toContain('Leads');
		expect(html).toContain('>2<'); // 2 leads
		expect(html).toContain('Opt-in');
		expect(html).toContain('Active windows');
	});
});

describe('queueCard', () => {
	it('counts queue rows by status', async () => {
		await db.prepare(`INSERT INTO message_queue (message_id, whatsapp, payload, status) VALUES ('a', '1', '{}', 'pending'), ('b', '1', '{}', 'pending'), ('c', '2', '{}', 'done')`).run();
		const html = await queueCard().render({ db, env: {}, query: {} });
		expect(html).toContain('pending');
		expect(html).toContain('>2<');
		expect(html).toContain('done');
	});

	it('shows empty state when queue is empty', async () => {
		const html = await queueCard().render({ db, env: {}, query: {} });
		expect(html).toContain('empty');
	});
});

describe('funnelCard', () => {
	it('renders one bar per funnel state', async () => {
		await db.prepare(`INSERT INTO leads (whatsapp, ad_data, funnel_state) VALUES ('1', '{}', 'NEW'), ('2', '{}', 'CHECKOUT'), ('3', '{}', 'CHECKOUT')`).run();
		const html = await funnelCard().render({ db, env: {}, query: {} });
		expect(html).toContain('NEW');
		expect(html).toContain('CHECKOUT');
	});
});

describe('messagesChartCard', () => {
	it('emits a Chart.js canvas with bar config', async () => {
		await db.prepare(`INSERT INTO messages (wamid, whatsapp, type, payload) VALUES ('w1', '1', 'text', '{}')`).run();
		const html = await messagesChartCard().render({ db, env: {}, query: {} });
		expect(html).toContain('<canvas');
		expect(html).toContain("type: 'bar'");
	});
});

describe('dauCard', () => {
	it('renders DAU + new-user line chart', async () => {
		await db.prepare(`INSERT INTO leads (whatsapp, ad_data) VALUES ('1', '{}')`).run();
		await db.prepare(`INSERT INTO messages (wamid, whatsapp, type, payload) VALUES ('w1', '1', 'text', '{}')`).run();
		const html = await dauCard().render({ db, env: {}, query: {} });
		expect(html).toContain("type: 'line'");
		expect(html).toContain('Active');
		expect(html).toContain('New');
	});
});

describe('engagementCard', () => {
	it('renders KPIs + bar breakdown', async () => {
		await db.prepare(`INSERT INTO engagement_answers (engagement_id, whatsapp, answer, date) VALUES (1, '1', 'a', date('now')), (1, '2', 'a', date('now')), (1, '3', 'b', date('now'))`).run();
		await db.prepare(`INSERT INTO broadcast_log (whatsapp, channel, date) VALUES ('1', 'engagement', date('now')), ('2', 'engagement', date('now')), ('3', 'engagement', date('now')), ('4', 'engagement', date('now'))`).run();

		const html = await engagementCard().render({ db, env: {}, query: {} });
		expect(html).toContain('Response rate');
		expect(html).toContain('Yes');
		expect(html).toContain('No');
		expect(html).toContain('Ignored');
	});

	it('shows zero state when no engagement data', async () => {
		const html = await engagementCard().render({ db, env: {}, query: {} });
		expect(html).toContain('0%');
	});
});

describe('plansCard', () => {
	it('renders one row per plan with completion %', async () => {
		await db.prepare(`INSERT INTO plans (id, slug, title, duration_days) VALUES (1, '21d', '21 days', 21)`).run();
		await db.prepare(`INSERT INTO user_plans (whatsapp, plan_id, is_active, completed_at) VALUES ('1', 1, 1, NULL), ('2', 1, 0, datetime('now'))`).run();

		const html = await plansCard().render({ db, env: {}, query: {} });
		expect(html).toContain('21 days');
		expect(html).toContain('50%'); // 1 of 2 completed
	});

	it('shows empty state with no plans', async () => {
		const html = await plansCard().render({ db, env: {}, query: {} });
		expect(html).toContain('No active plans');
	});
});

describe('gateConversionCard', () => {
	it('shows blocked + converted + rate from feature_usage × leads', async () => {
		const { gateConversionCard } = await import('../../src/dashboard/index.js');

		// 3 distinct users hit the AI gate; 1 of them later converted to SUBSCRIBE
		await db.prepare(`INSERT INTO leads (whatsapp, ad_data, funnel_state) VALUES ('1','{}','SUBSCRIBE'),('2','{}','CHECKOUT'),('3','{}','NEW')`).run();
		await db.prepare(`INSERT INTO feature_usage (whatsapp, feature) VALUES ('1','ai_gate_blocked'),('1','ai_gate_blocked'),('2','ai_gate_blocked'),('3','ai_gate_blocked')`).run();

		const html = await gateConversionCard().render({ db, env: {}, query: {} });
		expect(html).toContain('Blocked');
		expect(html).toContain('>3<');     // 3 distinct blocked
		expect(html).toContain('Converted');
		expect(html).toContain('>1<');     // 1 converted
		expect(html).toContain('33%');     // 1/3 rate
		expect(html).toContain('>4<');     // 4 total hits
	});

	it('honors custom feature + funnel state config', async () => {
		const { gateConversionCard } = await import('../../src/dashboard/index.js');
		await db.prepare(`INSERT INTO leads (whatsapp, ad_data, funnel_state) VALUES ('1','{}','PRO')`).run();
		await db.prepare(`INSERT INTO feature_usage (whatsapp, feature) VALUES ('1','tts_blocked')`).run();

		const html = await gateConversionCard({ feature: 'tts_blocked', convertedFunnelState: 'PRO' }).render({
			db,
			env: {},
			query: {},
		});
		expect(html).toContain('100%'); // 1 blocked, 1 converted
	});

	it('shows 0% when no one has been blocked', async () => {
		const { gateConversionCard } = await import('../../src/dashboard/index.js');
		const html = await gateConversionCard().render({ db, env: {}, query: {} });
		expect(html).toContain('0%');
	});
});

describe('churnCard', () => {
	it('counts opt-in users with no open window', async () => {
		await db.prepare(`INSERT INTO leads (whatsapp, ad_data, opt_in) VALUES ('1', '{}', 1), ('2', '{}', 1), ('3', '{}', 1)`).run();
		await db.prepare(`INSERT INTO message_windows (whatsapp, window_type, end_time) VALUES ('1', 'paid', datetime('now', '+1 hour'))`).run();

		const html = await churnCard().render({ db, env: {}, query: {} });
		// 2 of 3 opt-in users have no window → churned = 2
		expect(html).toContain('Churned');
		expect(html).toContain('>2<');
	});
});
