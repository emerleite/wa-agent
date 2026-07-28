import { describe, it, expect, vi } from 'vitest';
import { resolveReplyContext } from '../../src/util/reply_context.js';

describe('resolveReplyContext', () => {
	it('returns null when both lookups are absent', async () => {
		expect(await resolveReplyContext({ inReplyToWamid: 'x' })).toBeNull();
	});

	it('prefers reply-pointer hit over recency', async () => {
		const byReplyWamid = vi.fn(async () => ({ id: 'pointer-hit' }));
		const byRecency = vi.fn(async () => ({ id: 'recency-hit' }));
		const r = await resolveReplyContext({
			inReplyToWamid: 'wamid.abc',
			whatsapp: '5511',
			byReplyWamid,
			byRecency,
		});
		expect(r).toEqual({ id: 'pointer-hit' });
		expect(byRecency).not.toHaveBeenCalled();
	});

	it('falls through to recency when reply-pointer returns null', async () => {
		const byReplyWamid = vi.fn(async () => null);
		const byRecency = vi.fn(async () => ({ id: 'recency-hit' }));
		const r = await resolveReplyContext({
			inReplyToWamid: 'wamid.abc',
			whatsapp: '5511',
			byReplyWamid,
			byRecency,
		});
		expect(r).toEqual({ id: 'recency-hit' });
		expect(byReplyWamid).toHaveBeenCalledWith('wamid.abc');
	});

	it('skips reply-pointer lookup when inReplyToWamid is empty', async () => {
		const byReplyWamid = vi.fn();
		const byRecency = vi.fn(async () => ({ id: 'r' }));
		await resolveReplyContext({ inReplyToWamid: null, whatsapp: '5511', byReplyWamid, byRecency });
		expect(byReplyWamid).not.toHaveBeenCalled();
		expect(byRecency).toHaveBeenCalledWith('5511', 10);
	});

	it('honors custom withinMinutes', async () => {
		const byRecency = vi.fn(async () => null);
		await resolveReplyContext({ whatsapp: '5511', byRecency, withinMinutes: 30 });
		expect(byRecency).toHaveBeenCalledWith('5511', 30);
	});

	it('returns null when both lookups miss', async () => {
		const r = await resolveReplyContext({
			inReplyToWamid: 'x',
			whatsapp: '5511',
			byReplyWamid: async () => null,
			byRecency: async () => null,
		});
		expect(r).toBeNull();
	});
});
