import { describe, it, expect } from 'vitest';
import { HybridSearch } from '../../src/search/hybrid_search.js';
import type { DB } from '../../src/db/client.js';

// We're only testing the pure RRF math here. The DB-backed bm25/like methods
// have their own integration tests against a seeded D1 table.
function buildSearcher() {
	return new HybridSearch({
		// db is unused for rrf()
		db: {} as DB,
		contentTable: 'docs',
		searchColumns: ['title', 'body'],
	});
}

describe('HybridSearch.rrf', () => {
	const s = buildSearcher();

	it('returns empty for empty inputs', () => {
		expect(s.rrf([], [], 5)).toEqual([]);
	});

	it('promotes items appearing in BOTH ranked lists', () => {
		const A = { id: 1, title: 'A' };
		const B = { id: 2, title: 'B' };
		const C = { id: 3, title: 'C' };
		// A is rank 1 in both → highest combined score
		// B is rank 2 in keyword only
		// C is rank 2 in bm25 only
		const out = s.rrf([A, B], [A, C], 3);
		expect(out[0]?.id).toBe(1);
	});

	it('deduplicates by id', () => {
		const A = { id: 1, title: 'A' };
		const out = s.rrf([A, A], [A], 5);
		expect(out.length).toBe(1);
	});

	it('respects weights — bm25 dominates by default', () => {
		const X = { id: 1, title: 'X' };
		const Y = { id: 2, title: 'Y' };
		// X wins via bm25 (rank 1), loses keyword (rank 2)
		// Y wins via keyword (rank 1), loses bm25 (rank 2)
		// Default bm25Weight=0.65 keywordWeight=0.35 → X should rank higher
		const out = s.rrf([Y, X], [X, Y], 2);
		expect(out[0]?.id).toBe(1);
	});

	it('limits results', () => {
		const items = Array.from({ length: 10 }, (_, i) => ({ id: i }));
		const out = s.rrf(items, items, 3);
		expect(out.length).toBe(3);
	});

	it('higher rank = higher RRF score', () => {
		const A = { id: 1, title: 'A' };
		const B = { id: 2, title: 'B' };
		const out = s.rrf([A, B], [], 2);
		expect(out[0]?.score).toBeGreaterThan(out[1]?.score ?? -1);
	});
});
