import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { Broadcast } from '../../src/scheduler/broadcast.js';
import { LeadStore } from '../../src/lead/lead_store.js';
import { MessageWindow } from '../../src/window/message_window.js';
import { MockWhatsAppClient } from '../helpers/mock_client.js';
import type { WhatsAppClient } from '../../src/client/whatsapp.js';

const db = (env as { DB: D1Database }).DB;

async function reset() {
	await db.prepare('DELETE FROM leads').run();
	await db.prepare('DELETE FROM message_windows').run();
	await db.prepare('DELETE FROM broadcast_log').run();
}

async function makeAudience(opts: { whatsapp: string; optIn?: boolean; window?: 'open' | 'closed' | 'none' }) {
	const leads = new LeadStore({ db });
	const window = new MessageWindow({ db });
	await leads.upsert({ whatsapp: opts.whatsapp });
	if (opts.optIn !== false) await leads.optIn(opts.whatsapp);
	if (opts.window === 'open' || opts.window === undefined) {
		await window.start(opts.whatsapp);
	} else if (opts.window === 'closed') {
		await window.start(opts.whatsapp);
		await db.prepare("UPDATE message_windows SET end_time = datetime('now', '-1 hour') WHERE whatsapp = ?").bind(opts.whatsapp).run();
	}
}

beforeEach(reset);

describe('Broadcast', () => {
	it('default audience covers opt-in users in open windows', async () => {
		const client = new MockWhatsAppClient();
		await makeAudience({ whatsapp: '5551' });
		await makeAudience({ whatsapp: '5552' });

		const b = new Broadcast({ client: client as unknown as WhatsAppClient, db, channel: 'devotional', sendIntervalMs: 0 });
		const result = await b.run({ send: ({ whatsapp }) => client.sendText(whatsapp, 'hello') });

		expect(result.candidates).toBe(2);
		expect(result.delivered).toBe(2);
		expect(client.methods()).toEqual(['sendText', 'sendText']);
	});

	it('skips opt-out users', async () => {
		const client = new MockWhatsAppClient();
		await makeAudience({ whatsapp: '5551' });
		await makeAudience({ whatsapp: '5552', optIn: false });

		const b = new Broadcast({ client: client as unknown as WhatsAppClient, db, channel: 'x', sendIntervalMs: 0 });
		const result = await b.run({ send: ({ whatsapp }) => client.sendText(whatsapp, 'x') });

		expect(result.candidates).toBe(1);
		expect(client.calls[0]?.to).toBe('5551');
	});

	it('skips users with closed message windows', async () => {
		const client = new MockWhatsAppClient();
		await makeAudience({ whatsapp: '5551' });
		await makeAudience({ whatsapp: '5552', window: 'closed' });

		const b = new Broadcast({ client: client as unknown as WhatsAppClient, db, channel: 'x', sendIntervalMs: 0 });
		const result = await b.run({ send: ({ whatsapp }) => client.sendText(whatsapp, 'x') });

		expect(result.candidates).toBe(1);
	});

	it('does not double-send on a re-run within the same day', async () => {
		const client = new MockWhatsAppClient();
		await makeAudience({ whatsapp: '5551' });

		const b = new Broadcast({ client: client as unknown as WhatsAppClient, db, channel: 'devotional', sendIntervalMs: 0 });
		const first = await b.run({ send: ({ whatsapp }) => client.sendText(whatsapp, 'hi') });
		const second = await b.run({ send: ({ whatsapp }) => client.sendText(whatsapp, 'hi again') });

		expect(first.delivered).toBe(1);
		expect(second.delivered).toBe(0);
		expect(second.candidates).toBe(0);
	});

	it('different channels do not block each other', async () => {
		const client = new MockWhatsAppClient();
		await makeAudience({ whatsapp: '5551' });

		const a = new Broadcast({ client: client as unknown as WhatsAppClient, db, channel: 'A', sendIntervalMs: 0 });
		const b = new Broadcast({ client: client as unknown as WhatsAppClient, db, channel: 'B', sendIntervalMs: 0 });

		await a.run({ send: ({ whatsapp }) => client.sendText(whatsapp, 'a') });
		const second = await b.run({ send: ({ whatsapp }) => client.sendText(whatsapp, 'b') });
		expect(second.delivered).toBe(1);
	});

	it('skipped sends (returning false) are not logged as delivered', async () => {
		const client = new MockWhatsAppClient();
		await makeAudience({ whatsapp: '5551' });

		const b = new Broadcast({ client: client as unknown as WhatsAppClient, db, channel: 'x', sendIntervalMs: 0 });
		const result = await b.run({ send: async () => false });
		expect(result.delivered).toBe(0);
		expect(result.skipped).toBe(1);

		expect(await b.wasDeliveredToday('5551')).toBe(false);
	});

	it('handler exceptions count as skipped, not delivered', async () => {
		const client = new MockWhatsAppClient();
		await makeAudience({ whatsapp: '5551' });

		const b = new Broadcast({ client: client as unknown as WhatsAppClient, db, channel: 'x', sendIntervalMs: 0 });
		const result = await b.run({
			send: async () => {
				throw new Error('boom');
			},
		});
		expect(result.delivered).toBe(0);
		expect(result.skipped).toBe(1);
	});

	it('honors a custom audience query', async () => {
		const client = new MockWhatsAppClient();
		await makeAudience({ whatsapp: '5551' });
		await makeAudience({ whatsapp: '5552' });
		// custom query: only the lower number
		const b = new Broadcast({ client: client as unknown as WhatsAppClient, db, channel: 'x', sendIntervalMs: 0 });
		const result = await b.run({
			send: ({ whatsapp }) => client.sendText(whatsapp, 'x'),
			audienceQuery: 'SELECT whatsapp FROM leads WHERE whatsapp = ?',
			audienceBindings: ['5551'],
		});
		expect(result.delivered).toBe(1);
		expect(client.calls[0]?.to).toBe('5551');
	});

	it('wasDeliveredToday reports correctly for both states', async () => {
		const client = new MockWhatsAppClient();
		await makeAudience({ whatsapp: '5551' });
		const b = new Broadcast({ client: client as unknown as WhatsAppClient, db, channel: 'x', sendIntervalMs: 0 });
		expect(await b.wasDeliveredToday('5551')).toBe(false);
		await b.run({ send: ({ whatsapp }) => client.sendText(whatsapp, 'x') });
		expect(await b.wasDeliveredToday('5551')).toBe(true);
	});
});
