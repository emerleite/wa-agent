import { describe, it, expect } from 'vitest';
import { computeHoldout } from '../../src/util/holdout.js';

describe('computeHoldout — determinism', () => {
	it('same key + percentage → same answer twice', async () => {
		const a = await computeHoldout({ key: '5551', percentage: 25 });
		const b = await computeHoldout({ key: '5551', percentage: 25 });
		expect(a).toBe(b);
	});

	it('different keys can land on different sides', async () => {
		// Across a sample of 200 distinct keys at 50%, expect both sides represented.
		const results = await Promise.all(
			Array.from({ length: 200 }, (_, i) => computeHoldout({ key: `5551-${i}`, percentage: 50 })),
		);
		const trueCount = results.filter(Boolean).length;
		expect(trueCount).toBeGreaterThan(0);
		expect(trueCount).toBeLessThan(200);
	});
});

describe('computeHoldout — boundary values', () => {
	it('percentage = 0 is never in holdout', async () => {
		const results = await Promise.all(
			Array.from({ length: 100 }, (_, i) => computeHoldout({ key: `k-${i}`, percentage: 0 })),
		);
		expect(results.every((r) => r === false)).toBe(true);
	});

	it('percentage = 100 is always in holdout', async () => {
		const results = await Promise.all(
			Array.from({ length: 100 }, (_, i) => computeHoldout({ key: `k-${i}`, percentage: 100 })),
		);
		expect(results.every((r) => r === true)).toBe(true);
	});

	it('clamps negative percentage to 0 (never in holdout)', async () => {
		expect(await computeHoldout({ key: '5551', percentage: -10 })).toBe(false);
	});

	it('clamps >100 percentage to 100 (always in holdout)', async () => {
		expect(await computeHoldout({ key: '5551', percentage: 9999 })).toBe(true);
	});

	it('non-finite percentage (NaN, ±Infinity) → safe default 0 (never in holdout)', async () => {
		expect(await computeHoldout({ key: '5551', percentage: NaN })).toBe(false);
		expect(await computeHoldout({ key: '5551', percentage: Infinity })).toBe(false);
		expect(await computeHoldout({ key: '5551', percentage: -Infinity })).toBe(false);
	});
});

describe('computeHoldout — approximate distribution', () => {
	it('at 5% the actual rate across many keys is within ±3 percentage points', async () => {
		const n = 5000;
		const results = await Promise.all(
			Array.from({ length: n }, (_, i) => computeHoldout({ key: `wa-${i}`, percentage: 5 })),
		);
		const rate = results.filter(Boolean).length / n;
		expect(rate).toBeGreaterThan(0.02);
		expect(rate).toBeLessThan(0.08);
	});

	it('at 50% the actual rate across many keys lands near 50%', async () => {
		const n = 5000;
		const results = await Promise.all(
			Array.from({ length: n }, (_, i) => computeHoldout({ key: `wa-${i}`, percentage: 50 })),
		);
		const rate = results.filter(Boolean).length / n;
		expect(rate).toBeGreaterThan(0.45);
		expect(rate).toBeLessThan(0.55);
	});
});

describe('computeHoldout — salt', () => {
	it('same key + percentage but different salts produce independent draws', async () => {
		// At least ONE key in the sample should flip when the salt changes.
		const sampleSize = 200;
		let differs = 0;
		for (let i = 0; i < sampleSize; i++) {
			const a = await computeHoldout({ key: `wa-${i}`, percentage: 50 });
			const b = await computeHoldout({ key: `wa-${i}`, percentage: 50, salt: 'exp-q1' });
			if (a !== b) differs += 1;
		}
		// A truly independent re-draw at 50% expects ~50% to differ — well above 10.
		expect(differs).toBeGreaterThan(10);
	});

	it('same salt is stable', async () => {
		const a = await computeHoldout({ key: 'wa-1', percentage: 25, salt: 'exp-q1' });
		const b = await computeHoldout({ key: 'wa-1', percentage: 25, salt: 'exp-q1' });
		expect(a).toBe(b);
	});

	it('empty salt behaves like no salt', async () => {
		const a = await computeHoldout({ key: 'wa-1', percentage: 25 });
		const b = await computeHoldout({ key: 'wa-1', percentage: 25, salt: '' });
		expect(a).toBe(b);
	});

	it('salt isolates two experiments', async () => {
		// Two salts → two independent assignments at the same key.
		// Confirm at least one key differs between salts to validate independence.
		let differs = 0;
		for (let i = 0; i < 200; i++) {
			const a = await computeHoldout({ key: `tenant-${i}`, percentage: 30, salt: 'exp-A' });
			const b = await computeHoldout({ key: `tenant-${i}`, percentage: 30, salt: 'exp-B' });
			if (a !== b) differs += 1;
		}
		expect(differs).toBeGreaterThan(10);
	});
});

describe('computeHoldout — psico parity', () => {
	// Psico's `isInHoldout` is exactly: SHA-256(key) → first 4 bytes BE → mod 100
	// → strict-less-than percentage. Reimplement it in-test and check that
	// `computeHoldout({ key, percentage })` (no salt) returns the same boolean
	// for every key in a sample. Locks the algorithm so an adoption swap
	// (`isInHoldout = computeHoldout`) is safe.
	async function psicoOriginal(key: string, percentage: number): Promise<boolean> {
		const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key));
		const view = new DataView(buf);
		const n = view.getUint32(0, false) % 100;
		return n < Math.max(0, Math.min(100, percentage));
	}

	it('matches the psico algorithm for every key in a sample', async () => {
		const sample = [
			'5511988887777',
			'tenant-1:patient-1:2026-05-15',
			'tenant-A:abc-DEF-123',
			'',
			'x',
		];
		for (const key of sample) {
			for (const percentage of [5, 25, 50, 75]) {
				const ours = await computeHoldout({ key, percentage });
				const theirs = await psicoOriginal(key, percentage);
				expect(ours).toBe(theirs);
			}
		}
	});
});
