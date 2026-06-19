/**
 * Hybrid BM25 + Keyword (LIKE) search over a D1 FTS5 table, fused with RRF.
 *
 * From v0.2 onward: backed by Drizzle ORM. Content tables and FTS5 virtual
 * tables are app-defined and not part of the framework's schema, so queries
 * use Drizzle's `sql\`...\`` template — `sql.raw()` for identifiers (table /
 * column names from the constructor) and `sql\`${x}\`` for user-supplied
 * values (parameterized).
 */
import { sql } from 'drizzle-orm';
import { normalizeDb, type DB } from '../db/client.js';

export interface HybridSearchOptions {
	/**
	 * D1 binding OR a pre-built Drizzle client (any schema). v0.7+:
	 * normalized internally.
	 */
	db: D1Database | DB;
	contentTable: string;
	ftsTable?: string;
	searchColumns: string[];
	filters?: Record<string, unknown>;
	rrfK?: number;
	bm25Weight?: number;
	keywordWeight?: number;
	dedupKey?: (row: Record<string, unknown>) => string;
}

export interface SearchOptions {
	limit?: number;
	filters?: Record<string, unknown>;
}

export interface ScoredRow extends Record<string, unknown> {
	score: number;
	_kw: number;
	_bm: number;
}

export class HybridSearch {
	readonly db: DB;
	readonly contentTable: string;
	readonly ftsTable: string;
	readonly searchColumns: string[];
	readonly filters: Record<string, unknown>;
	readonly rrfK: number;
	readonly bm25Weight: number;
	readonly keywordWeight: number;
	readonly dedupKey: (row: Record<string, unknown>) => string;

	constructor({
		db,
		contentTable,
		ftsTable,
		searchColumns,
		filters = {},
		rrfK = 60,
		bm25Weight = 0.65,
		keywordWeight = 0.35,
		dedupKey = (r) => `${(r.rowid ?? r.id) as string | number}`,
	}: HybridSearchOptions) {
		if (!db) throw new Error('HybridSearch: db required');
		if (!contentTable) throw new Error('HybridSearch: contentTable required');
		if (!searchColumns?.length) throw new Error('HybridSearch: searchColumns required');
		this.db = normalizeDb(db);
		this.contentTable = contentTable;
		this.ftsTable = ftsTable || `${contentTable}_fts`;
		this.searchColumns = searchColumns;
		this.filters = filters;
		this.rrfK = rrfK;
		this.bm25Weight = bm25Weight;
		this.keywordWeight = keywordWeight;
		this.dedupKey = dedupKey;
	}

	async search<T extends Record<string, unknown> = Record<string, unknown>>(
		query: string,
		{ limit = 5, filters = {} }: SearchOptions = {}
	): Promise<(T & ScoredRow)[]> {
		if (!query || query.trim().length < 2) return [];

		const expand = limit * 3;
		const [bm25, keyword] = await Promise.all([this.bm25(query, expand, filters), this.like(query, expand, filters)]);

		if (!bm25.length && !keyword.length) return [];
		return this.rrf<T>(keyword as T[], bm25 as T[], limit);
	}

	async bm25<T = Record<string, unknown>>(query: string, limit: number, filters: Record<string, unknown> = {}): Promise<T[]> {
		const fts = sql.raw(this.ftsTable);
		const content = sql.raw(this.contentTable);
		const where = this.buildFilterFragment(filters);
		try {
			const stmt = sql`
				SELECT c.*, bm25(${fts}) as score
				FROM ${fts} fts
				JOIN ${content} c ON c.rowid = fts.rowid
				WHERE ${fts} MATCH ${query}
				${where ? sql` AND ${where}` : sql``}
				ORDER BY score
				LIMIT ${limit}`;
			const r = await this.db.all<T>(stmt);
			return r as T[];
		} catch (e) {
			console.error('[HybridSearch.bm25]', e instanceof Error ? e.message : e);
			return [];
		}
	}

	async like<T = Record<string, unknown>>(query: string, limit: number, filters: Record<string, unknown> = {}): Promise<T[]> {
		const pattern = `%${query.replace(/[%_]/g, '\\$&')}%`;
		const content = sql.raw(this.contentTable);
		const ors = sql.join(
			this.searchColumns.map((c) => sql`${sql.raw(c)} LIKE ${pattern} ESCAPE '\\'`),
			sql` OR `
		);
		const where = this.buildFilterFragment(filters);
		try {
			const stmt = sql`
				SELECT * FROM ${content}
				WHERE (${ors})
				${where ? sql` AND ${where}` : sql``}
				LIMIT ${limit}`;
			const r = await this.db.all<T>(stmt);
			return r as T[];
		} catch (e) {
			console.error('[HybridSearch.like]', e instanceof Error ? e.message : e);
			return [];
		}
	}

	private buildFilterFragment(extra: Record<string, unknown> = {}) {
		const merged = { ...this.filters, ...extra };
		const keys = Object.keys(merged);
		if (!keys.length) return null;
		return sql.join(
			keys.map((k) => sql`${sql.raw(k)} = ${merged[k]}`),
			sql` AND `
		);
	}

	rrf<T extends Record<string, unknown>>(keyword: T[], bm25: T[], limit: number): (T & ScoredRow)[] {
		const map = new Map<string, T & { _kw: number; _bm: number }>();

		keyword.forEach((row, i) => {
			const key = this.dedupKey(row);
			if (!map.has(key)) map.set(key, { ...row, _kw: 0, _bm: 0 });
			map.get(key)!._kw = 1 / (this.rrfK + i + 1);
		});

		bm25.forEach((row, i) => {
			const key = this.dedupKey(row);
			if (!map.has(key)) map.set(key, { ...row, _kw: 0, _bm: 0 });
			map.get(key)!._bm = 1 / (this.rrfK + i + 1);
		});

		const fused: (T & ScoredRow)[] = [...map.values()].map((item) => ({
			...item,
			score: item._kw * this.keywordWeight + item._bm * this.bm25Weight,
		}));
		fused.sort((a, b) => b.score - a.score);
		return fused.slice(0, limit);
	}
}

export interface SearchSchemaArgs {
	contentTable: string;
	ftsTable?: string;
	ftsColumns: string[];
	tokenize?: string;
}

export function buildSearchSchema({ contentTable, ftsTable, ftsColumns, tokenize = 'trigram remove_diacritics 1' }: SearchSchemaArgs): string[] {
	const fts = ftsTable || `${contentTable}_fts`;
	const colList = ftsColumns.join(', ');
	const newCols = ftsColumns.map((c) => `new.${c}`).join(', ');
	return [
		`CREATE VIRTUAL TABLE IF NOT EXISTS ${fts} USING fts5(${colList}, tokenize='${tokenize}')`,
		`CREATE TRIGGER IF NOT EXISTS ${fts}_ai AFTER INSERT ON ${contentTable} BEGIN
			INSERT INTO ${fts}(rowid, ${colList}) VALUES (new.rowid, ${newCols});
		END`,
		`CREATE TRIGGER IF NOT EXISTS ${fts}_au AFTER UPDATE ON ${contentTable} BEGIN
			UPDATE ${fts} SET ${ftsColumns.map((c) => `${c} = new.${c}`).join(', ')} WHERE rowid = new.rowid;
		END`,
		`CREATE TRIGGER IF NOT EXISTS ${fts}_ad AFTER DELETE ON ${contentTable} BEGIN
			DELETE FROM ${fts} WHERE rowid = old.rowid;
		END`,
	];
}
