/**
 * Persistent conversation memory for AgentLoop (v0.11).
 *
 * Backs the multi-turn history the loop injects into each LLM call. Each
 * `AgentLoop.run(...)` writes one row per message it processes (user +
 * assistant + tool result) with a shared `turnId` for correlation.
 *
 *   const memory = new ConversationMemory({ db: env.DB });
 *   const window = await memory.loadWindow('5511987654321', { limit: 20 });
 *   // → AgentMessage[] in chronological order, ready to append to a system
 *   // prompt and hand to AgentLLM.
 *
 * Apps with bespoke observability tables retarget the store via `tableName`
 * + `columnMap` + `omitColumns` + `allowedExtraColumns` — same pattern as
 * `EscalationStore` / `ConsentStore` / `AICallLedger`.
 *
 * Distinct from `MessageLog` (audit / dashboards): `agent_turns` captures
 * the exact structure needed to reconstruct machine state, tool calls
 * included. `MessageLog` continues to hold user-facing utterances for
 * humans to review.
 */
import { sql } from 'drizzle-orm';
import { normalizeDb, type DB } from '../db/client.js';
import type { AgentMessage, ToolCall } from './types.js';

export type MemoryField =
	| 'id'
	| 'turnId'
	| 'whatsapp'
	| 'stepIndex'
	| 'role'
	| 'content'
	| 'toolCallsJson'
	| 'toolCallId'
	| 'toolName'
	| 'tenantId'
	| 'createdAt';

export const DEFAULT_MEMORY_COLUMNS: Readonly<Record<MemoryField, string>> = Object.freeze({
	id: 'id',
	turnId: 'turn_id',
	whatsapp: 'whatsapp',
	stepIndex: 'step_index',
	role: 'role',
	content: 'content',
	toolCallsJson: 'tool_calls_json',
	toolCallId: 'tool_call_id',
	toolName: 'tool_name',
	tenantId: 'tenant_id',
	createdAt: 'created_at',
});

const SAFE_IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

export interface ConversationMemoryOptions {
	db: D1Database | DB;
	/** Physical table name. Default `'agent_turns'`. */
	tableName?: string;
	columnMap?: Partial<Record<MemoryField, string>>;
	omitColumns?: ReadonlyArray<MemoryField>;
	allowedExtraColumns?: ReadonlyArray<string>;
	/**
	 * Multi-tenant scoping. When set, every append writes this value and
	 * every load restricts to it. Null / undefined = no scoping.
	 */
	tenantId?: string | null;
}

export interface AppendRowInput {
	turnId: string;
	whatsapp: string;
	stepIndex: number;
	message: AgentMessage;
	extraColumns?: Record<string, string | number | null>;
}

export interface LoadWindowOptions {
	/** Max messages to load. Default 20. */
	limit?: number;
	/**
	 * Optional per-load tenant override — usually unnecessary since the
	 * store is constructed with a tenantId, but useful when one instance
	 * serves multiple tenants.
	 */
	tenantId?: string | null;
}

interface RawRow {
	stepIndex: number;
	role: string;
	content: string;
	toolCallsJson: string | null;
	toolCallId: string | null;
	toolName: string | null;
	createdAt: string;
}

export class ConversationMemory {
	readonly db: DB;
	readonly tableName: string;
	readonly columns: Readonly<Record<MemoryField, string>>;
	readonly omitColumns: ReadonlySet<MemoryField>;
	readonly allowedExtraColumns: ReadonlySet<string>;
	readonly tenantId: string | null;

	constructor({
		db,
		tableName = 'agent_turns',
		columnMap,
		omitColumns,
		allowedExtraColumns,
		tenantId,
	}: ConversationMemoryOptions) {
		if (!db) throw new Error('ConversationMemory: db required');
		if (!SAFE_IDENT.test(tableName)) {
			throw new Error('ConversationMemory: tableName must be a bare SQL identifier');
		}
		const merged: Record<MemoryField, string> = { ...DEFAULT_MEMORY_COLUMNS };
		if (columnMap) {
			for (const [k, v] of Object.entries(columnMap) as Array<[MemoryField, string | undefined]>) {
				if (v === undefined) continue;
				if (!SAFE_IDENT.test(v)) {
					throw new Error(`ConversationMemory: columnMap.${k} must be a bare SQL identifier`);
				}
				merged[k] = v;
			}
		}
		const extra = new Set<string>();
		if (allowedExtraColumns) {
			for (const name of allowedExtraColumns) {
				if (!SAFE_IDENT.test(name)) {
					throw new Error(`ConversationMemory: allowedExtraColumns "${name}" must be a bare SQL identifier`);
				}
				extra.add(name);
			}
		}
		this.db = normalizeDb(db);
		this.tableName = tableName;
		this.columns = Object.freeze(merged);
		this.omitColumns = new Set(omitColumns ?? []);
		this.allowedExtraColumns = extra;
		this.tenantId = tenantId ?? null;
	}

	/**
	 * Append a single row. The loop typically calls this once per message
	 * as it processes each step, so partial failures leave a
	 * self-consistent trail up to the failure point.
	 */
	async append(input: AppendRowInput): Promise<string> {
		if (!input.turnId) throw new Error('ConversationMemory.append: turnId required');
		if (!input.whatsapp) throw new Error('ConversationMemory.append: whatsapp required');
		if (!Number.isInteger(input.stepIndex) || input.stepIndex < 1) {
			throw new Error('ConversationMemory.append: stepIndex must be a positive integer');
		}
		if (input.message.role === 'system') {
			throw new Error('ConversationMemory.append: system messages are not persisted');
		}

		const id = crypto.randomUUID();
		const c = this.columns;
		const msg = input.message;
		const toolCallsJson =
			msg.role === 'assistant' && msg.toolCalls && msg.toolCalls.length > 0
				? JSON.stringify(msg.toolCalls)
				: null;
		const toolCallId = msg.role === 'tool' ? msg.toolCallId : null;
		const toolName = msg.role === 'tool' ? msg.toolName : null;
		const framework: Array<[MemoryField, unknown]> = [
			['id', id],
			['turnId', input.turnId],
			['whatsapp', input.whatsapp],
			['stepIndex', input.stepIndex],
			['role', msg.role],
			['content', msg.content],
			['toolCallsJson', toolCallsJson],
			['toolCallId', toolCallId],
			['toolName', toolName],
			['tenantId', this.tenantId],
		];
		const cols: Array<ReturnType<typeof sql>> = [];
		const vals: Array<unknown> = [];
		for (const [field, value] of framework) {
			if (this.omitColumns.has(field)) continue;
			cols.push(sql.raw(c[field]));
			vals.push(value);
		}
		if (input.extraColumns) {
			for (const [name, value] of Object.entries(input.extraColumns)) {
				if (!this.allowedExtraColumns.has(name)) {
					throw new Error(`ConversationMemory.append: extraColumns.${name} is not in allowedExtraColumns`);
				}
				cols.push(sql.raw(name));
				vals.push(value);
			}
		}
		await this.db.run(sql`
			INSERT INTO ${sql.raw(this.tableName)} (${sql.join(cols, sql`, `)})
			VALUES (${sql.join(vals.map((v) => sql`${v}`), sql`, `)})`);
		return id;
	}

	/**
	 * Load the most recent N messages for a user, in chronological order
	 * (oldest first) so callers can append to a system prompt without
	 * reversing.
	 *
	 * The window may split a turn — e.g. return a tool result whose
	 * assistant parent is beyond `limit`. That's fine for the LLM (it
	 * ignores dangling tool rows that predate its context), but callers
	 * that need strict turn-atomicity should size `limit` generously.
	 */
	async loadWindow(whatsapp: string, opts: LoadWindowOptions = {}): Promise<AgentMessage[]> {
		if (!whatsapp) throw new Error('ConversationMemory.loadWindow: whatsapp required');
		const limit = opts.limit ?? 20;
		if (!Number.isInteger(limit) || limit <= 0) {
			throw new Error('ConversationMemory.loadWindow: limit must be a positive integer');
		}
		const tenantId = opts.tenantId !== undefined ? opts.tenantId : this.tenantId;
		const c = this.columns;
		const filters: Array<ReturnType<typeof sql>> = [sql`${sql.raw(c.whatsapp)} = ${whatsapp}`];
		if (tenantId !== null && tenantId !== undefined) {
			filters.push(sql`${sql.raw(c.tenantId)} = ${tenantId}`);
		} else {
			filters.push(sql`${sql.raw(c.tenantId)} IS NULL`);
		}
		const where = sql`WHERE ${sql.join(filters, sql` AND `)}`;
		const rows = await this.db.all<RawRow>(sql`
			SELECT
				${sql.raw(c.stepIndex)} AS "stepIndex",
				${sql.raw(c.role)} AS role,
				${sql.raw(c.content)} AS content,
				${sql.raw(c.toolCallsJson)} AS "toolCallsJson",
				${sql.raw(c.toolCallId)} AS "toolCallId",
				${sql.raw(c.toolName)} AS "toolName",
				${sql.raw(c.createdAt)} AS "createdAt"
			FROM ${sql.raw(this.tableName)}
			${where}
			ORDER BY ${sql.raw(c.createdAt)} DESC, ${sql.raw(c.stepIndex)} DESC
			LIMIT ${limit}`);
		// DB returns newest first (LIMIT N of DESC); flip for the LLM.
		return rows.reverse().map((row) => this.rowToMessage(row));
	}

	/**
	 * Load every row of a single turn, in step order. Useful for
	 * post-hoc debugging (dashboards, tracer replays).
	 */
	async loadTurn(turnId: string): Promise<AgentMessage[]> {
		if (!turnId) throw new Error('ConversationMemory.loadTurn: turnId required');
		const c = this.columns;
		const rows = await this.db.all<RawRow>(sql`
			SELECT
				${sql.raw(c.stepIndex)} AS "stepIndex",
				${sql.raw(c.role)} AS role,
				${sql.raw(c.content)} AS content,
				${sql.raw(c.toolCallsJson)} AS "toolCallsJson",
				${sql.raw(c.toolCallId)} AS "toolCallId",
				${sql.raw(c.toolName)} AS "toolName",
				${sql.raw(c.createdAt)} AS "createdAt"
			FROM ${sql.raw(this.tableName)}
			WHERE ${sql.raw(c.turnId)} = ${turnId}
			ORDER BY ${sql.raw(c.stepIndex)} ASC, ${sql.raw(c.createdAt)} ASC`);
		return rows.map((row) => this.rowToMessage(row));
	}

	private rowToMessage(row: RawRow): AgentMessage {
		if (row.role === 'user') {
			return { role: 'user', content: row.content };
		}
		if (row.role === 'assistant') {
			const toolCalls = row.toolCallsJson ? (JSON.parse(row.toolCallsJson) as ToolCall[]) : undefined;
			if (toolCalls && toolCalls.length > 0) {
				return { role: 'assistant', content: row.content, toolCalls };
			}
			return { role: 'assistant', content: row.content };
		}
		if (row.role === 'tool') {
			return {
				role: 'tool',
				toolCallId: row.toolCallId ?? '',
				toolName: row.toolName ?? '',
				content: row.content,
			};
		}
		throw new Error(`ConversationMemory: unknown role "${row.role}" in stored row`);
	}
}
