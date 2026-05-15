/**
 * Self-healing daily-content table.
 *
 * Idempotently ensures one row exists for a given date in an app-defined
 * table (e.g. `devotional`, `daily_tip`, `quote_of_the_day`). The shape:
 *
 *   1. Look up `date = ?`. Treat a row as usable when its content is at
 *      least `minUsableLength` characters AND the date string matches the
 *      `YYYY-MM-DD` glob (defensive against historical writers that
 *      corrupted the date column).
 *   2. Usable + not forced → no-op.
 *   3. Otherwise call `generate(date)`. On success, INSERT or UPDATE the
 *      row using parameterized bindings (so the generated text can never
 *      leak across columns).
 *
 * The table is supplied by the app; this primitive doesn't own a schema.
 * Provide your own migration with at minimum a `date TEXT PRIMARY KEY` (or
 * UNIQUE) plus a content column. Extra columns are left untouched on
 * INSERT (your defaults / nullable columns kick in) and on UPDATE unless
 * listed in `resetColumns`.
 *
 * Pair with `Broadcast` to deliver each day's row at a cron tick:
 *
 *   const generator = new ContentGenerator({
 *     db: agent.db,
 *     table: 'devotional',
 *     resetColumns: ['audio_url'],
 *     generate: (date) => llm.write(`devotional for ${date}`),
 *   });
 *
 *   agent.cron('0 8 * * *', async () => {
 *     const r = await generator.ensureToday();
 *     if (r.status === 'failed') return;
 *     // ...broadcast today's row
 *   });
 */
import { sql } from 'drizzle-orm';
import type { DB } from '../db/client.js';

export interface ContentGeneratorOptions {
	db: DB;
	/** Name of the app-defined content table. */
	table: string;
	/** Column holding the YYYY-MM-DD date. Default `date`. */
	dateColumn?: string;
	/** Column holding the generated body. Default `content`. */
	contentColumn?: string;
	/**
	 * Columns to NULL on update — typically derived artifacts that no longer
	 * match new content (e.g. cached audio_url, summary, image_url). Pass an
	 * empty array (default) to leave every other column alone.
	 */
	resetColumns?: string[];
	/**
	 * Minimum length the content must reach to count as usable. Below this,
	 * a row is treated as missing and regenerated. Default 80.
	 */
	minUsableLength?: number;
	/**
	 * Produce content for `date`. Return null/empty to signal a recoverable
	 * failure (the row is left alone; caller sees status='failed'). Throwing
	 * is also recoverable — caught and surfaced as failed.
	 */
	generate: (date: string) => Promise<string | null>;
}

export type EnsureStatus = 'skipped' | 'created' | 'updated' | 'failed';

export interface EnsureResult {
	status: EnsureStatus;
	id?: number;
	reason?: 'invalid_date' | 'generation_failed';
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const SAFE_IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

export class ContentGenerator {
	readonly db: DB;
	readonly table: string;
	readonly dateColumn: string;
	readonly contentColumn: string;
	readonly resetColumns: string[];
	readonly minUsableLength: number;
	readonly generateFn: (date: string) => Promise<string | null>;

	constructor(opts: ContentGeneratorOptions) {
		const {
			db,
			table,
			dateColumn = 'date',
			contentColumn = 'content',
			resetColumns = [],
			minUsableLength = 80,
			generate,
		} = opts;
		if (!db) throw new Error('ContentGenerator: db required');
		if (!table || !SAFE_IDENT.test(table)) {
			throw new Error('ContentGenerator: table must be a bare SQL identifier');
		}
		if (!SAFE_IDENT.test(dateColumn) || !SAFE_IDENT.test(contentColumn)) {
			throw new Error('ContentGenerator: dateColumn/contentColumn must be bare SQL identifiers');
		}
		for (const c of resetColumns) {
			if (!SAFE_IDENT.test(c)) throw new Error(`ContentGenerator: resetColumns entry "${c}" is not a valid identifier`);
		}
		if (typeof generate !== 'function') throw new Error('ContentGenerator: generate function required');

		this.db = db;
		this.table = table;
		this.dateColumn = dateColumn;
		this.contentColumn = contentColumn;
		this.resetColumns = resetColumns;
		this.minUsableLength = minUsableLength;
		this.generateFn = generate;
	}

	/** Convenience — ensure a row exists for today (UTC). */
	async ensureToday(opts: { force?: boolean } = {}): Promise<EnsureResult> {
		return this.ensureForDate(new Date().toISOString().slice(0, 10), opts);
	}

	async ensureForDate(date: string, { force = false }: { force?: boolean } = {}): Promise<EnsureResult> {
		if (!DATE_RE.test(date)) return { status: 'failed', reason: 'invalid_date' };

		const existing = await this.findExisting(date);
		const usable = existing && existing.content !== null && existing.content.length >= this.minUsableLength;
		if (usable && !force) return { status: 'skipped', id: existing.id };

		let content: string | null;
		try {
			content = await this.generateFn(date);
		} catch (e) {
			console.error('[ContentGenerator] generate threw:', e instanceof Error ? e.message : e);
			return { status: 'failed', reason: 'generation_failed' };
		}
		if (!content || content.length < this.minUsableLength) {
			return { status: 'failed', reason: 'generation_failed' };
		}

		if (existing) {
			await this.updateRow(existing.id, content);
			return { status: 'updated', id: existing.id };
		}
		const id = await this.insertRow(date, content);
		return { status: 'created', id };
	}

	/** Direct generation passthrough — useful for tests and ops scripts. */
	async generate(date: string): Promise<string | null> {
		try {
			return await this.generateFn(date);
		} catch (e) {
			console.error('[ContentGenerator] generate threw:', e instanceof Error ? e.message : e);
			return null;
		}
	}

	private async findExisting(date: string): Promise<{ id: number; content: string | null } | null> {
		const table = sql.raw(this.table);
		const dateCol = sql.raw(this.dateColumn);
		const contentCol = sql.raw(this.contentColumn);
		// The GLOB filter guards against historical writers that leak content
		// into the date column. Skipping such rows lets the generator overwrite
		// them on the next run.
		const stmt = sql`
			SELECT id, ${contentCol} AS content
			FROM ${table}
			WHERE ${dateCol} = ${date} AND ${dateCol} GLOB '????-??-??'
			LIMIT 1`;
		const rows = await this.db.all<{ id: number; content: string | null }>(stmt);
		return rows[0] ?? null;
	}

	private async insertRow(date: string, content: string): Promise<number> {
		const table = sql.raw(this.table);
		const dateCol = sql.raw(this.dateColumn);
		const contentCol = sql.raw(this.contentColumn);
		const stmt = sql`
			INSERT INTO ${table} (${dateCol}, ${contentCol})
			VALUES (${date}, ${content})
			RETURNING id`;
		const rows = await this.db.all<{ id: number }>(stmt);
		return rows[0]?.id ?? 0;
	}

	private async updateRow(id: number, content: string): Promise<void> {
		const table = sql.raw(this.table);
		const contentCol = sql.raw(this.contentColumn);
		const resets = this.resetColumns.length
			? sql.join(
					this.resetColumns.map((c) => sql`${sql.raw(c)} = NULL`),
					sql`, `,
				)
			: null;
		const stmt = resets
			? sql`UPDATE ${table} SET ${contentCol} = ${content}, ${resets} WHERE id = ${id}`
			: sql`UPDATE ${table} SET ${contentCol} = ${content} WHERE id = ${id}`;
		await this.db.run(stmt);
	}
}
