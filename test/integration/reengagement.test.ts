import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { ReEngagement } from '../../src/scheduler/reengagement.js';
import { MockWhatsAppClient } from '../helpers/mock_client.js';
import type { WhatsAppClient } from '../../src/client/whatsapp.js';

const db = (env as { DB: D1Database }).DB;

beforeEach(async () => {
	await db.prepare('DELETE FROM engagement_answers').run();
});

function makeRE(client: MockWhatsAppClient, topicId = 1) {
	return new ReEngagement({
		client: client as unknown as WhatsAppClient,
		db,
		topicId,
		question: { body: 'Did you read?', yesLabel: 'Yes', noLabel: 'No' },
	});
}

describe('ReEngagement', () => {
	it('ask() sends a button message with correct ids', async () => {
		const client = new MockWhatsAppClient();
		const re = makeRE(client);
		await re.ask('5551');
		expect(client.methods()).toEqual(['sendButtons']);
		const data = client.calls[0]?.args[0] as { buttons: Array<{ id: string; title: string }> };
		expect(data.buttons.map((b) => b.id)).toEqual(['engagement_1_a', 'engagement_1_b']);
	});

	it('ask({useTemplate:true}) sends a template when configured', async () => {
		const client = new MockWhatsAppClient();
		const re = new ReEngagement({
			client: client as unknown as WhatsAppClient,
			db,
			topicId: 7,
			question: { body: 'X' },
			template: { name: 'engagement_t', language: 'en_US' },
		});
		await re.ask('5551', { useTemplate: true });
		expect(client.methods()).toEqual(['sendTemplate']);
	});

	it('falls back to buttons when useTemplate=true but no template configured', async () => {
		const client = new MockWhatsAppClient();
		const re = makeRE(client);
		await re.ask('5551', { useTemplate: true });
		expect(client.methods()).toEqual(['sendButtons']);
	});

	it('recordAnswer stores yes/no and date is yesterday', async () => {
		const client = new MockWhatsAppClient();
		const re = makeRE(client);
		await re.recordAnswer('5551', 'engagement_1_a');
		const row = await db.prepare(`SELECT answer, date, julianday('now') - julianday(date) AS day_offset FROM engagement_answers WHERE whatsapp = ?`).bind('5551').first<{ answer: string; date: string; day_offset: number }>();
		expect(row?.answer).toBe('a');
		expect(row?.day_offset).toBeGreaterThanOrEqual(1);
		expect(row?.day_offset).toBeLessThan(2);
	});

	it('recordAnswer accepts raw answer letter without engagement_ prefix', async () => {
		const client = new MockWhatsAppClient();
		const re = makeRE(client);
		await re.recordAnswer('5551', 'a');
		const row = await db.prepare(`SELECT answer FROM engagement_answers WHERE whatsapp = ?`).bind('5551').first<{ answer: string }>();
		expect(row?.answer).toBe('a');
	});

	describe('weekProgress', () => {
		it('returns 7 days with nulls for unanswered', async () => {
			const client = new MockWhatsAppClient();
			const re = makeRE(client);
			const progress = await re.weekProgress('5551');
			expect(progress.length).toBe(7);
			expect(progress.every((p) => p.answer === null)).toBe(true);
			expect(progress.map((p) => p.day_of_week)).toEqual([1, 2, 3, 4, 5, 6, 7]);
		});

		it('fills in answered days while leaving others null', async () => {
			const client = new MockWhatsAppClient();
			const re = makeRE(client);

			// 6 days ago: answered "a"
			await db
				.prepare(`INSERT INTO engagement_answers (engagement_id, whatsapp, answer, date) VALUES (?, ?, ?, date('now', '-6 days'))`)
				.bind(1, '5551', 'a')
				.run();
			// 4 days ago: answered "b"
			await db
				.prepare(`INSERT INTO engagement_answers (engagement_id, whatsapp, answer, date) VALUES (?, ?, ?, date('now', '-4 days'))`)
				.bind(1, '5551', 'b')
				.run();

			const progress = await re.weekProgress('5551');
			const answered = progress.filter((p) => p.answer !== null);
			expect(answered.length).toBe(2);
			expect(answered.map((p) => p.answer).sort()).toEqual(['a', 'b']);
		});

		it('isolates progress by topicId', async () => {
			const client = new MockWhatsAppClient();
			const re1 = makeRE(client, 1);
			const re2 = makeRE(client, 2);

			await db
				.prepare(`INSERT INTO engagement_answers (engagement_id, whatsapp, answer, date) VALUES (?, ?, ?, date('now', '-3 days'))`)
				.bind(1, '5551', 'a')
				.run();

			const t1 = await re1.weekProgress('5551');
			const t2 = await re2.weekProgress('5551');
			expect(t1.filter((p) => p.answer).length).toBe(1);
			expect(t2.filter((p) => p.answer).length).toBe(0);
		});

		it('isolates progress by user', async () => {
			const client = new MockWhatsAppClient();
			const re = makeRE(client);

			await db
				.prepare(`INSERT INTO engagement_answers (engagement_id, whatsapp, answer, date) VALUES (?, ?, ?, date('now', '-2 days'))`)
				.bind(1, '5551', 'a')
				.run();

			const a = await re.weekProgress('5551');
			const b = await re.weekProgress('5552');
			expect(a.filter((p) => p.answer).length).toBe(1);
			expect(b.filter((p) => p.answer).length).toBe(0);
		});
	});
});
