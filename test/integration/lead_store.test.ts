import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { LeadStore } from '../../src/lead/lead_store.js';

const db = (env as { DB: D1Database }).DB;

beforeEach(async () => {
	await db.prepare('DELETE FROM leads').run();
});

describe('LeadStore', () => {
	const store = new LeadStore({ db });

	it('upsert inserts new lead with default funnel state', async () => {
		await store.upsert({ whatsapp: '5551', adData: { source: 'organic' } });
		const r = await store.get('5551');
		expect(r?.whatsapp).toBe('5551');
		expect(r?.funnel_state).toBe('NEW');
		expect(r?.opt_in).toBe(0);
	});

	it('upsert is idempotent — second call does not overwrite', async () => {
		await store.upsert({ whatsapp: '5551', funnelState: 'ONBOARDING' });
		await store.upsert({ whatsapp: '5551', funnelState: 'NEW' });
		const r = await store.get('5551');
		expect(r?.funnel_state).toBe('ONBOARDING');
	});

	it('optIn / optOut toggle the flag and stamp dates', async () => {
		await store.upsert({ whatsapp: '5551' });
		await store.optIn('5551');
		const after = await store.get('5551');
		expect(after?.opt_in).toBe(1);
		expect(after?.opt_in_date).toBeTruthy();

		await store.optOut('5551');
		const out = await store.get('5551');
		expect(out?.opt_in).toBe(0);
		expect(out?.opt_out_date).toBeTruthy();
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
		expect(r?.funnel_state).toBe('CHECKOUT');
	});
});
