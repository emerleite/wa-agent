import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { LeadStore } from '../../src/lead/lead_store.js';
import { createDb } from '../../src/db/client.js';

const d1 = (env as { DB: D1Database }).DB;
const db = createDb(d1);

beforeEach(async () => {
	await d1.prepare('DELETE FROM leads').run();
});

describe('LeadStore', () => {
	const store = new LeadStore({ db });

	it('upsert inserts new lead with default funnel state', async () => {
		await store.upsert({ whatsapp: '5551', adData: { source: 'organic' } });
		const r = await store.get('5551');
		expect(r?.whatsapp).toBe('5551');
		expect(r?.funnelState).toBe('NEW');
		expect(r?.optIn).toBe(0);
	});

	it('upsert is idempotent — second call does not overwrite', async () => {
		await store.upsert({ whatsapp: '5551', funnelState: 'ONBOARDING' });
		await store.upsert({ whatsapp: '5551', funnelState: 'NEW' });
		const r = await store.get('5551');
		expect(r?.funnelState).toBe('ONBOARDING');
	});

	it('optIn / optOut toggle the flag and stamp dates', async () => {
		await store.upsert({ whatsapp: '5551' });
		await store.optIn('5551');
		const after = await store.get('5551');
		expect(after?.optIn).toBe(1);
		expect(after?.optInDate).toBeTruthy();

		await store.optOut('5551');
		const out = await store.get('5551');
		expect(out?.optIn).toBe(0);
		expect(out?.optOutDate).toBeTruthy();
	});

	it('isOptIn returns boolean for known and unknown users', async () => {
		expect(await store.isOptIn('unknown')).toBe(false);
		await store.upsert({ whatsapp: '5551' });
		expect(await store.isOptIn('5551')).toBe(false);
		await store.optIn('5551');
		expect(await store.isOptIn('5551')).toBe(true);
	});

	it('setFunnelState rejects unknown states', async () => {
		await store.upsert({ whatsapp: '5551' });
		await expect(store.setFunnelState('5551', 'INVALID')).rejects.toThrow(/unknown funnel state/);
	});

	it('setFunnelState updates allowed states', async () => {
		await store.upsert({ whatsapp: '5551' });
		await store.setFunnelState('5551', 'CHECKOUT');
		const r = await store.get('5551');
		expect(r?.funnelState).toBe('CHECKOUT');
	});
});
