import { describe, it, expect } from 'vitest';
import { weightedPick } from '../../src/scheduler/slot_delivery.js';

describe('weightedPick', () => {
	it('returns null on empty array', () => {
		expect(weightedPick([])).toBeNull();
	});

	it('returns the only item when there is one', () => {
		const item = { id: 1, weight: 5 };
		expect(weightedPick([item])).toBe(item);
	});

	it('respects weights with seeded RNG', () => {
		// rng=0 → first item (heaviest); rng=0.99 → last item (lightest)
		const items = [
			{ id: 'A', weight: 100 },
			{ id: 'B', weight: 1 },
		];
		expect(weightedPick(items, () => 0)?.id).toBe('A');
		expect(weightedPick(items, () => 0.999)?.id).toBe('B');
	});

	it('treats missing weight as 1', () => {
		const items = [{ id: 'A' }, { id: 'B' }];
		// total = 2, rng=0 falls into A
		expect(weightedPick(items, () => 0)?.id).toBe('A');
		expect(weightedPick(items, () => 0.6)?.id).toBe('B');
	});

	it('approximates expected distribution over many trials', () => {
		const items = [
			{ id: 'A', weight: 90 },
			{ id: 'B', weight: 10 },
		];
		const counts: Record<string, number> = { A: 0, B: 0 };
		// deterministic seeded RNG (mulberry32)
		let s = 1;
		const rng = () => {
			s |= 0;
			s = (s + 0x6d2b79f5) | 0;
			let t = Math.imul(s ^ (s >>> 15), 1 | s);
			t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
			return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
		};
		for (let i = 0; i < 10_000; i++) {
			const pick = weightedPick(items, rng);
			counts[pick!.id]!++;
		}
		// Expect ~9000 / 1000 split, ±5%
		expect(counts.A).toBeGreaterThan(8500);
		expect(counts.A).toBeLessThan(9500);
	});
});
