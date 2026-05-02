import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { MessageLog } from '../../src/session/message_log.js';

const db = (env as { DB: D1Database }).DB;

beforeEach(async () => {
	await db.prepare('DELETE FROM messages').run();
});

describe('MessageLog', () => {
	const log = new MessageLog({ db });

	it('logInbound stores wamid + payload', async () => {
		const ok = await log.logInbound({
			wamid: 'wamid.1',
			whatsapp: '5551',
			type: 'text',
			payload: { hello: 'world' },
		});
		expect(ok).toBe(true);

		const row = await log.byWamid('wamid.1');
		expect(row?.whatsapp).toBe('5551');
		expect(row?.type).toBe('text');
		expect(JSON.parse(row?.payload || '{}')).toEqual({ hello: 'world' });
	});

	it('logInbound accepts pre-stringified payload', async () => {
		await log.logInbound({ wamid: 'wamid.s', whatsapp: '5551', type: 'text', payload: '{"raw":true}' });
		const row = await log.byWamid('wamid.s');
		expect(row?.payload).toBe('{"raw":true}');
	});

	it('logInbound returns false on duplicate wamid (UNIQUE constraint)', async () => {
		await log.logInbound({ wamid: 'dup', whatsapp: '5551', type: 'text', payload: {} });
		const second = await log.logInbound({ wamid: 'dup', whatsapp: '5551', type: 'text', payload: {} });
		expect(second).toBe(false);
	});

	it('updateAnswer fills in body/response/summary', async () => {
		await log.logInbound({ wamid: 'w1', whatsapp: '5551', type: 'text', payload: {} });
		const ok = await log.updateAnswer('w1', { body: 'hi', response: 'hello', summary: 'hi response' });
		expect(ok).toBe(true);

		const row = await log.byWamid('w1');
		expect(row?.body).toBe('hi');
		expect(row?.response).toBe('hello');
		expect(row?.summary).toBe('hi response');
	});

	it('byWamid returns null for unknown wamid', async () => {
		expect(await log.byWamid('nonexistent')).toBeNull();
	});

	it('totalForUser counts only that user', async () => {
		await log.logInbound({ wamid: 'a', whatsapp: '5551', type: 'text', payload: {} });
		await log.logInbound({ wamid: 'b', whatsapp: '5551', type: 'text', payload: {} });
		await log.logInbound({ wamid: 'c', whatsapp: '5552', type: 'text', payload: {} });
		expect(await log.totalForUser('5551')).toBe(2);
		expect(await log.totalForUser('5552')).toBe(1);
		expect(await log.totalForUser('unknown')).toBe(0);
	});
});
