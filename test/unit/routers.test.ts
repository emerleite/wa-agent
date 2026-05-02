import { describe, it, expect, vi } from 'vitest';
import { CommandRouter } from '../../src/router/command_router.js';
import { ButtonRouter } from '../../src/router/button_router.js';

describe('CommandRouter', () => {
	it('matches single alias case-insensitively', async () => {
		const r = new CommandRouter<{ tag: string }>();
		const handler = vi.fn();
		r.command('help', handler);
		expect(await r.dispatch('HELP', { tag: 'x' })).toBe(true);
		expect(handler).toHaveBeenCalledWith({ tag: 'x' });
	});

	it('matches any of multiple aliases', async () => {
		const r = new CommandRouter();
		const a = vi.fn();
		const b = vi.fn();
		r.command(['plan', 'plans'], a);
		r.command('help', b);
		await r.dispatch('plans', {});
		expect(a).toHaveBeenCalled();
		expect(b).not.toHaveBeenCalled();
	});

	it('first registration wins on alias conflicts', async () => {
		const r = new CommandRouter();
		const first = vi.fn();
		const second = vi.fn();
		r.command('x', first);
		r.command('x', second);
		await r.dispatch('x', {});
		expect(first).toHaveBeenCalled();
		expect(second).not.toHaveBeenCalled();
	});

	it('falls back when no command matches', async () => {
		const r = new CommandRouter();
		const fb = vi.fn();
		r.command('help', vi.fn());
		r.fallback(fb);
		const ran = await r.dispatch('whatever', {});
		expect(ran).toBe(true);
		expect(fb).toHaveBeenCalled();
	});

	it('returns false when no match and no fallback', async () => {
		const r = new CommandRouter();
		r.command('help', vi.fn());
		expect(await r.dispatch('nope', {})).toBe(false);
	});

	it('trims whitespace before matching', async () => {
		const r = new CommandRouter();
		const h = vi.fn();
		r.command('help', h);
		await r.dispatch('  help  ', {});
		expect(h).toHaveBeenCalled();
	});
});

describe('ButtonRouter', () => {
	it('exact match wins over prefix', async () => {
		const r = new ButtonRouter();
		const exact = vi.fn();
		const prefix = vi.fn();
		r.exact('plan_status', exact);
		r.prefix('plan_', prefix);
		await r.dispatch('plan_status', {});
		expect(exact).toHaveBeenCalled();
		expect(prefix).not.toHaveBeenCalled();
	});

	it('longest matching prefix wins', async () => {
		const r = new ButtonRouter();
		const planDone = vi.fn();
		const plan = vi.fn();
		r.prefix('plan_', plan);
		r.prefix('plan_done_', planDone);
		await r.dispatch('plan_done_42_3', {});
		expect(planDone).toHaveBeenCalled();
		expect(plan).not.toHaveBeenCalled();
	});

	it('exposes suffix to handler', async () => {
		const r = new ButtonRouter<{}>();
		const handler = vi.fn();
		r.prefix('expand_', handler);
		await r.dispatch('expand_wamid_abc123', {});
		expect(handler).toHaveBeenCalledWith(expect.objectContaining({ buttonId: 'expand_wamid_abc123', suffix: 'wamid_abc123' }));
	});

	it('returns false for null/undefined buttonId', async () => {
		const r = new ButtonRouter();
		r.prefix('x_', vi.fn());
		expect(await r.dispatch(null, {})).toBe(false);
		expect(await r.dispatch(undefined, {})).toBe(false);
	});

	it('falls back when nothing matches', async () => {
		const r = new ButtonRouter();
		const fb = vi.fn();
		r.exact('opt-in', vi.fn());
		r.fallback(fb);
		await r.dispatch('something-else', {});
		expect(fb).toHaveBeenCalledWith(expect.objectContaining({ buttonId: 'something-else' }));
	});
});
