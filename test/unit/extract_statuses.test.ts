import { describe, it, expect } from 'vitest';
import { extractStatuses } from '../../src/webhook/extract.js';

describe('extractStatuses', () => {
	it('returns [] for empty envelope', () => {
		expect(extractStatuses(null)).toEqual([]);
		expect(extractStatuses(undefined)).toEqual([]);
		expect(extractStatuses({} as never)).toEqual([]);
	});

	it('extracts basic status fields', () => {
		const env = {
			entry: [
				{
					changes: [
						{
							value: {
								statuses: [
									{
										id: 'wamid.abc',
										status: 'delivered',
										timestamp: '1700000000',
										recipient_id: '5511999999999',
									},
								],
							},
						},
					],
				},
			],
			// biome-ignore lint/suspicious/noExplicitAny: test envelope shape
		} as any;
		const [s] = extractStatuses(env);
		expect(s?.wamid).toBe('wamid.abc');
		expect(s?.status).toBe('delivered');
		expect(s?.recipient).toBe('5511999999999');
		expect(s?.timestampMs).toBe(1700000000 * 1000);
	});

	it('extracts pricing.category (utility→marketing alarm surface)', () => {
		const env = {
			entry: [
				{
					changes: [
						{
							value: {
								statuses: [
									{
										id: 'wamid.x',
										status: 'sent',
										pricing: { category: 'marketing' },
										timestamp: '1700000000',
									},
								],
							},
						},
					],
				},
			],
			// biome-ignore lint/suspicious/noExplicitAny: test envelope shape
		} as any;
		const [s] = extractStatuses(env);
		expect(s?.pricingCategory).toBe('marketing');
	});

	it('handles multiple statuses in one envelope', () => {
		const env = {
			entry: [
				{
					changes: [
						{
							value: {
								statuses: [
									{ id: 'w1', status: 'sent', timestamp: '1700000000' },
									{ id: 'w2', status: 'delivered', timestamp: '1700000001' },
								],
							},
						},
					],
				},
			],
			// biome-ignore lint/suspicious/noExplicitAny: test envelope shape
		} as any;
		expect(extractStatuses(env)).toHaveLength(2);
	});

	it('preserves errors array when present', () => {
		const env = {
			entry: [
				{
					changes: [
						{
							value: {
								statuses: [
									{
										id: 'wamid.fail',
										status: 'failed',
										timestamp: '1700000000',
										errors: [{ code: 131047, message: 'Re-engagement required' }],
									},
								],
							},
						},
					],
				},
			],
			// biome-ignore lint/suspicious/noExplicitAny: test envelope shape
		} as any;
		const [s] = extractStatuses(env);
		expect(s?.errors).toEqual([{ code: 131047, message: 'Re-engagement required' }]);
	});
});
