import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { env } from 'cloudflare:test';
import { ContentGenerator } from '../../src/content/content_generator.js';
import { createDb } from '../../src/db/client.js';

const d1 = (env as { DB: D1Database }).DB;
const db = createDb(d1);

const BODY_80 = 'a'.repeat(120);
const BODY_OTHER = 'b'.repeat(120);

beforeAll(async () => {
	// App-defined content table — ContentGenerator is renderer-agnostic.
	await d1
		.prepare(
			`CREATE TABLE IF NOT EXISTS test_devotional (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				date TEXT NOT NULL UNIQUE,
				content TEXT NOT NULL,
				audio_url TEXT,
				summary TEXT
			)`,
		)
		.run();
});

beforeEach(async () => {
	await d1.prepare('DELETE FROM test_devotional').run();
});

function make(overrides: Partial<ConstructorParameters<typeof ContentGenerator>[0]> = {}) {
	return new ContentGenerator({
		db,
		table: 'test_devotional',
		resetColumns: ['audio_url', 'summary'],
		generate: async () => BODY_80,
		...overrides,
	});
}

describe('ContentGenerator — config validation', () => {
	it('throws on missing db', () => {
		expect(
			// @ts-expect-error testing
			() => new ContentGenerator({ table: 'x', generate: async () => 'x' }),
		).toThrow();
	});

	it('throws on missing generate', () => {
		expect(
			// @ts-expect-error testing
			() => new ContentGenerator({ db, table: 'x' }),
		).toThrow();
	});

	it('refuses non-identifier table names (defense against injection)', () => {
		expect(() => new ContentGenerator({ db, table: 'foo; drop table bar', generate: async () => 'x' })).toThrow();
		expect(() => new ContentGenerator({ db, table: '`foo`', generate: async () => 'x' })).toThrow();
		expect(() => new ContentGenerator({ db, table: '', generate: async () => 'x' })).toThrow();
	});

	it('refuses non-identifier column names', () => {
		expect(
			() => new ContentGenerator({ db, table: 'x', dateColumn: 'date; drop', generate: async () => 'x' }),
		).toThrow();
		expect(
			() => new ContentGenerator({ db, table: 'x', contentColumn: '"content"', generate: async () => 'x' }),
		).toThrow();
		expect(
			() => new ContentGenerator({ db, table: 'x', resetColumns: ['bad name'], generate: async () => 'x' }),
		).toThrow();
	});
});

describe('ContentGenerator.ensureForDate', () => {
	it('creates a row when missing', async () => {
		const gen = vi.fn(async () => BODY_80);
		const c = make({ generate: gen });
		const r = await c.ensureForDate('2026-05-15');
		expect(r.status).toBe('created');
		expect(r.id).toBeGreaterThan(0);
		expect(gen).toHaveBeenCalledOnce();
		const row = await d1.prepare(`SELECT content FROM test_devotional WHERE date = '2026-05-15'`).first<{ content: string }>();
		expect(row?.content).toBe(BODY_80);
	});

	it('is idempotent — skips when a usable row already exists', async () => {
		const c = make({ generate: async () => BODY_80 });
		const r1 = await c.ensureForDate('2026-05-15');
		expect(r1.status).toBe('created');

		const gen2 = vi.fn(async () => 'new');
		const c2 = make({ generate: gen2 });
		const r2 = await c2.ensureForDate('2026-05-15');
		expect(r2.status).toBe('skipped');
		expect(gen2).not.toHaveBeenCalled();
	});

	it('regenerates when force=true and resets the resetColumns', async () => {
		const c = make({ generate: async () => BODY_80 });
		await c.ensureForDate('2026-05-15');
		await d1
			.prepare(`UPDATE test_devotional SET audio_url = ?, summary = ? WHERE date = ?`)
			.bind('https://x/a.mp3', 'one-liner', '2026-05-15')
			.run();

		const c2 = make({ generate: async () => BODY_OTHER });
		const r = await c2.ensureForDate('2026-05-15', { force: true });
		expect(r.status).toBe('updated');

		const row = await d1
			.prepare(`SELECT content, audio_url, summary FROM test_devotional WHERE date = '2026-05-15'`)
			.first<{ content: string; audio_url: string | null; summary: string | null }>();
		expect(row?.content).toBe(BODY_OTHER);
		expect(row?.audio_url).toBeNull();
		expect(row?.summary).toBeNull();
	});

	it('overwrites and resets when an existing row has too-short content', async () => {
		await d1
			.prepare(`INSERT INTO test_devotional (date, content, audio_url) VALUES ('2026-05-15', 'short', 'https://x/a.mp3')`)
			.run();
		const c = make({ generate: async () => BODY_80 });
		const r = await c.ensureForDate('2026-05-15');
		expect(r.status).toBe('updated');
		const row = await d1
			.prepare(`SELECT content, audio_url FROM test_devotional WHERE date = '2026-05-15'`)
			.first<{ content: string; audio_url: string | null }>();
		expect(row?.content).toBe(BODY_80);
		expect(row?.audio_url).toBeNull();
	});

	it('returns invalid_date for bad input', async () => {
		const c = make();
		expect((await c.ensureForDate('not-a-date')).status).toBe('failed');
		expect((await c.ensureForDate('2026/05/15')).status).toBe('failed');
		expect((await c.ensureForDate('2026-5-15')).status).toBe('failed');
		expect((await c.ensureForDate('')).status).toBe('failed');
		expect((await c.ensureForDate('not-a-date')).reason).toBe('invalid_date');
	});

	it('returns generation_failed when generate returns null', async () => {
		const c = make({ generate: async () => null });
		const r = await c.ensureForDate('2026-05-15');
		expect(r).toEqual({ status: 'failed', reason: 'generation_failed' });
	});

	it('returns generation_failed when generate returns too-short text', async () => {
		const c = make({ generate: async () => 'short', minUsableLength: 80 });
		expect((await c.ensureForDate('2026-05-15')).status).toBe('failed');
	});

	it('catches a throw inside generate and surfaces as failure', async () => {
		const c = make({
			generate: async () => {
				throw new Error('LLM 500');
			},
		});
		const r = await c.ensureForDate('2026-05-15');
		expect(r).toEqual({ status: 'failed', reason: 'generation_failed' });
	});

	it('treats malformed-date rows as missing (GLOB guard against historical corruption)', async () => {
		// Insert a row whose `date` column was corrupted by an earlier writer.
		await d1
			.prepare(`INSERT INTO test_devotional (date, content) VALUES ('2026/05/15', ?)`)
			.bind(BODY_80)
			.run();
		const c = make({ generate: async () => BODY_OTHER });
		const r = await c.ensureForDate('2026-05-15');
		expect(r.status).toBe('created'); // ignored the corrupted row, inserted a clean one
		const rows = await d1
			.prepare(`SELECT date, content FROM test_devotional ORDER BY id`)
			.all<{ date: string; content: string }>();
		const results = rows.results ?? [];
		expect(results).toHaveLength(2);
		expect(results[1]?.date).toBe('2026-05-15');
	});

	it('respects custom minUsableLength', async () => {
		const c = make({ generate: async () => 'just enough!', minUsableLength: 5 });
		const r = await c.ensureForDate('2026-05-15');
		expect(r.status).toBe('created');
	});

	it('leaves non-reset columns alone on update', async () => {
		const c = make({ resetColumns: ['summary'], generate: async () => BODY_80 });
		await c.ensureForDate('2026-05-15');
		await d1
			.prepare(`UPDATE test_devotional SET audio_url = 'https://x/a.mp3', summary = 's' WHERE date = '2026-05-15'`)
			.run();
		const c2 = make({ resetColumns: ['summary'], generate: async () => BODY_OTHER });
		await c2.ensureForDate('2026-05-15', { force: true });
		const row = await d1
			.prepare(`SELECT audio_url, summary FROM test_devotional WHERE date = '2026-05-15'`)
			.first<{ audio_url: string | null; summary: string | null }>();
		expect(row?.audio_url).toBe('https://x/a.mp3');
		expect(row?.summary).toBeNull();
	});
});

describe('ContentGenerator.ensureToday', () => {
	it('delegates to ensureForDate with today (UTC)', async () => {
		const today = new Date().toISOString().slice(0, 10);
		const c = make({ generate: async () => BODY_80 });
		const r = await c.ensureToday();
		expect(r.status).toBe('created');
		const row = await d1.prepare(`SELECT date FROM test_devotional`).first<{ date: string }>();
		expect(row?.date).toBe(today);
	});
});

describe('ContentGenerator.generate', () => {
	it('returns the generated text', async () => {
		const c = make({ generate: async () => 'hello' });
		expect(await c.generate('2026-05-15')).toBe('hello');
	});

	it('returns null when generator throws (no propagation)', async () => {
		const c = make({
			generate: async () => {
				throw new Error('boom');
			},
		});
		expect(await c.generate('2026-05-15')).toBeNull();
	});
});
