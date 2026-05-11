import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { MessageWindow } from '../../src/window/message_window.js';
import { createDb } from '../../src/db/client.js';

const d1 = (env as { DB: D1Database }).DB;
const db = createDb(d1);

beforeEach(async () => {
	await d1.prepare('DELETE FROM message_windows').run();
});

describe('MessageWindow', () => {
	const window = new MessageWindow({ db });

	it('start() opens a paid window for a new user', async () => {
		await window.start('5551');
		const status = await window.status('5551');
		expect(status.inWindow).toBe(true);
		expect(status.type).toBe('paid');
	});

	it('start("free") opens a free (longer) window', async () => {
		await window.start('5551', 'free');
		const status = await window.status('5551');
		expect(status.type).toBe('free');
	});

	it('status returns inWindow=false for unknown user', async () => {
		const status = await window.status('unknown');
		expect(status.inWindow).toBe(false);
		expect(status.type).toBeNull();
	});

	it('start() renews an existing window', async () => {
		await window.start('5551');
		// Backdate to expire
		await d1.prepare("UPDATE message_windows SET end_time = datetime('now', '-1 hour') WHERE whatsapp = '5551'").run();
		const before = await window.status('5551');
		expect(before.inWindow).toBe(false);

		await window.start('5551');
		const after = await window.status('5551');
		expect(after.inWindow).toBe(true);
	});

	it('listOpen returns currently-open windows only', async () => {
		await window.start('5551');
		await window.start('5552');
		await window.start('5553');
		// Close one
		await d1.prepare("UPDATE message_windows SET end_time = datetime('now', '-1 hour') WHERE whatsapp = '5552'").run();

		const open = await window.listOpen();
		expect(open.length).toBe(2);
		expect(open.map((o) => o.whatsapp).sort()).toEqual(['5551', '5553']);
	});
});
