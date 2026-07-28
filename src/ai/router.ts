/**
 * Multi-provider LLM router with circuit-breaker, total-budget, and
 * pluggable per-call ledger (v0.9).
 *
 *   const breaker = new CircuitBreaker();
 *   const ledger = new AICallLedger({ db: env.DB });
 *   const router = new AIRouter({
 *     providers: {
 *       groq_8b: () => new OpenAICompatProvider({
 *         name: 'groq_8b',
 *         url: 'https://api.groq.com/openai/v1/chat/completions',
 *         apiKey: env.GROQ_API_KEY,
 *         model: 'llama-3.1-8b-instant',
 *       }),
 *       workers_ai: () => new WorkersAIProvider({
 *         name: 'workers_ai',
 *         ai: env.AI,
 *         model: '@cf/meta/llama-3.1-8b-instruct-fast',
 *       }),
 *     },
 *     resolveChain: (task) => ['groq_8b', 'workers_ai'],
 *     breaker,
 *     ledger,
 *   });
 *
 *   const r = await router.route('classifier', { system: '...', user: 'hi' });
 *   if (r.ok) console.log(r.response);
 *
 * The router walks the chain in order, skipping providers whose breaker is
 * OPEN and providers that would exceed the total wall-clock budget. Each
 * attempt is logged via the ledger when one is configured.
 *
 * Cost estimation is the caller's responsibility — pass `estimateCost` on
 * construction (typically backed by `LLMCostCalculator` or a static price
 * table) to get per-call µUSD in the ledger rows.
 */
import type { LLMProvider, ProviderErrorKind } from './llm_provider.js';
import type { CircuitBreaker, CircuitErrorKind } from './circuit_breaker.js';
import type { AICallLedger, CallStatus } from './ai_call_log.js';

type ProviderFactory = LLMProvider | (() => LLMProvider);

export interface AIRouterOptions {
	/**
	 * Map of provider name → factory OR instance. Factories are invoked once
	 * per route call (cheap; usually wraps env-bound constructors). Instances
	 * are reused as-is.
	 */
	providers: Record<string, ProviderFactory>;
	/**
	 * Resolve a task label to an ordered provider chain. Return [] to
	 * short-circuit (router returns `errorKind: 'config'`).
	 *
	 * Typical implementations read env vars (`env.AI_CHAIN_${task}`) and/or
	 * a per-tenant override D1 table.
	 */
	resolveChain: (task: string) => Promise<readonly string[]> | readonly string[];
	/**
	 * Per-provider circuit breaker. Optional — when omitted, every provider
	 * is tried regardless of past failures.
	 */
	breaker?: CircuitBreaker | null;
	/**
	 * Persistent ledger of every attempt. Optional — when omitted, the router
	 * only emits a structured stdout log per attempt.
	 */
	ledger?: AICallLedger | null;
	/** Per-call timeout passed to the provider's `run()`. Default 3000ms. */
	timeoutMs?: number;
	/**
	 * Total wall-clock budget across the chain. When exceeded, remaining
	 * providers are skipped with status `skipped_budget`. Default 9000ms.
	 */
	totalBudgetMs?: number;
	/**
	 * Optional cost estimator: `(provider, tokensIn, tokensOut) → micro-USD`.
	 * The result is forwarded to the ledger's `estCostMicroUsd`. When absent,
	 * the ledger column is NULL.
	 */
	estimateCost?: (provider: string, tokensIn: number | null, tokensOut: number | null) => number | null;
	/** `Date.now`-compatible clock (test override). */
	now?: () => number;
}

export interface RouteArgs {
	system: string;
	user: string;
	maxTokens?: number;
	temperature?: number;
	/** Forwarded to ledger rows for per-tenant analytics. */
	tenantId?: string | null;
	/** Forwarded to ledger rows for per-user debug. */
	whatsapp?: string | null;
	/**
	 * v0.16: derive extra ledger columns from the winning provider's raw
	 * response. Fires on SUCCESS only. Return keys must be listed in the
	 * ledger's `allowedExtraColumns` — the callback is a cheap way to
	 * inline classifier category / intent / route tag into `ai_call_log`
	 * without a follow-up UPDATE. Errors from the callback are swallowed
	 * (never fail the route because logging failed).
	 */
	extraLogFields?: (response: string) => Record<string, string | number | null>;
}

export interface ChainAttempt {
	provider: string;
	status: CallStatus;
	latencyMs?: number;
}

export interface RouteSuccess {
	ok: true;
	provider: string;
	response: string;
	model: string;
	tokensIn: number | null;
	tokensOut: number | null;
	latencyMs: number;
	chainTried: ChainAttempt[];
}

export interface RouteFailure {
	ok: false;
	errorKind: ProviderErrorKind | 'config' | 'all_failed';
	errorMessage: string;
	chainTried: ChainAttempt[];
}

export type RouteResult = RouteSuccess | RouteFailure;

const TRUNCATE = 500;

function truncate(s: string): string {
	return s.length > TRUNCATE ? s.slice(0, TRUNCATE) : s;
}

function resolveProvider(factory: ProviderFactory): LLMProvider {
	return typeof factory === 'function' ? factory() : factory;
}

function logStdout(row: {
	task: string;
	provider: string;
	model?: string | null;
	status: CallStatus;
	latencyMs?: number | null;
	tokensIn?: number | null;
	tokensOut?: number | null;
	estCostMicroUsd?: number | null;
	httpStatus?: number | null;
	errorKind?: string | null;
}): void {
	console.log(
		`[ai] task=${row.task} provider=${row.provider} model=${row.model ?? '-'} status=${row.status}` +
			` lat=${row.latencyMs ?? '-'}ms tin=${row.tokensIn ?? '-'} tout=${row.tokensOut ?? '-'}` +
			` cost_uUSD=${row.estCostMicroUsd ?? '-'} http=${row.httpStatus ?? '-'} err=${row.errorKind ?? '-'}`,
	);
}

export class AIRouter {
	readonly providers: Record<string, ProviderFactory>;
	readonly resolveChain: AIRouterOptions['resolveChain'];
	readonly breaker: CircuitBreaker | null;
	readonly ledger: AICallLedger | null;
	readonly timeoutMs: number;
	readonly totalBudgetMs: number;
	readonly estimateCost: AIRouterOptions['estimateCost'];
	readonly now: () => number;

	constructor(opts: AIRouterOptions) {
		if (!opts.providers || Object.keys(opts.providers).length === 0) {
			throw new Error('AIRouter: providers map must be non-empty');
		}
		if (!opts.resolveChain) {
			throw new Error('AIRouter: resolveChain required');
		}
		this.providers = opts.providers;
		this.resolveChain = opts.resolveChain;
		this.breaker = opts.breaker ?? null;
		this.ledger = opts.ledger ?? null;
		this.timeoutMs = opts.timeoutMs ?? 3000;
		this.totalBudgetMs = opts.totalBudgetMs ?? 9000;
		this.estimateCost = opts.estimateCost;
		this.now = opts.now ?? (() => Date.now());
	}

	async route(task: string, args: RouteArgs): Promise<RouteResult> {
		if (!task) throw new Error('AIRouter.route: task required');
		const chain = await this.resolveChain(task);
		if (!chain || chain.length === 0) {
			return { ok: false, errorKind: 'config', errorMessage: `no chain configured for task "${task}"`, chainTried: [] };
		}
		const startedAt = this.now();
		const chainTried: ChainAttempt[] = [];

		for (const providerName of chain) {
			const elapsed = this.now() - startedAt;
			if (elapsed >= this.totalBudgetMs) {
				chainTried.push({ provider: providerName, status: 'skipped_budget' });
				await this.logAttempt({ task, provider: providerName, status: 'skipped_budget', tenantId: args.tenantId, whatsapp: args.whatsapp });
				continue;
			}
			if (this.breaker && !this.breaker.canCall(providerName)) {
				chainTried.push({ provider: providerName, status: 'skipped_open' });
				await this.logAttempt({ task, provider: providerName, status: 'skipped_open', tenantId: args.tenantId, whatsapp: args.whatsapp });
				continue;
			}
			const factory = this.providers[providerName];
			if (!factory) {
				chainTried.push({ provider: providerName, status: 'error' });
				await this.logAttempt({
					task,
					provider: providerName,
					status: 'error',
					errorKind: 'config',
					errorMessage: 'unknown_provider',
					tenantId: args.tenantId,
					whatsapp: args.whatsapp,
				});
				continue;
			}
			const provider = resolveProvider(factory);

			const t0 = this.now();
			const remaining = this.totalBudgetMs - elapsed;
			const perCallTimeout = Math.min(this.timeoutMs, remaining);
			const result = await provider.run({
				system: args.system,
				user: args.user,
				maxTokens: args.maxTokens,
				temperature: args.temperature,
				timeoutMs: perCallTimeout,
			});
			const latencyMs = this.now() - t0;

			if (result.ok) {
				this.breaker?.recordSuccess(providerName);
				chainTried.push({ provider: providerName, status: 'success', latencyMs });
				const cost = this.estimateCost ? this.estimateCost(providerName, result.tokensIn, result.tokensOut) : null;
				let extraColumns: Record<string, string | number | null> | undefined;
				if (args.extraLogFields) {
					try {
						extraColumns = args.extraLogFields(result.response);
					} catch (e) {
						console.log(`[ai] extraLogFields hook threw: ${e instanceof Error ? e.message : String(e)}`);
					}
				}
				await this.logAttempt({
					task,
					provider: providerName,
					model: result.model,
					status: 'success',
					httpStatus: result.httpStatus,
					latencyMs,
					tokensIn: result.tokensIn,
					tokensOut: result.tokensOut,
					estCostMicroUsd: cost,
					tenantId: args.tenantId,
					whatsapp: args.whatsapp,
					extraColumns,
				});
				return {
					ok: true,
					provider: providerName,
					response: result.response,
					model: result.model,
					tokensIn: result.tokensIn,
					tokensOut: result.tokensOut,
					latencyMs,
					chainTried,
				};
			}

			// Failure path
			this.breaker?.recordFailure(providerName, result.errorKind as CircuitErrorKind);
			const status: CallStatus =
				result.errorKind === '429'
					? 'rate_limited'
					: result.errorKind === 'timeout'
						? 'timeout'
						: result.errorKind === 'parse'
							? 'parse_error'
							: 'error';
			chainTried.push({ provider: providerName, status, latencyMs });
			await this.logAttempt({
				task,
				provider: providerName,
				model: result.model,
				status,
				httpStatus: result.httpStatus ?? null,
				latencyMs,
				errorKind: result.errorKind,
				errorMessage: truncate(result.errorMessage),
				tenantId: args.tenantId,
				whatsapp: args.whatsapp,
			});
		}

		return {
			ok: false,
			errorKind: 'all_failed',
			errorMessage: `all ${chain.length} providers failed or skipped`,
			chainTried,
		};
	}

	private async logAttempt(row: {
		task: string;
		provider: string;
		status: CallStatus;
		model?: string | null;
		httpStatus?: number | null;
		latencyMs?: number | null;
		tokensIn?: number | null;
		tokensOut?: number | null;
		estCostMicroUsd?: number | null;
		errorKind?: string | null;
		errorMessage?: string | null;
		tenantId?: string | null;
		whatsapp?: string | null;
		extraColumns?: Record<string, string | number | null>;
	}): Promise<void> {
		logStdout(row);
		if (!this.ledger) return;
		try {
			await this.ledger.record(row);
		} catch (e) {
			console.error('[ai] ledger.record threw:', e instanceof Error ? e.message : e);
		}
	}
}

/**
 * Common pattern for `resolveChain`: read `env.AI_CHAIN_${task.toUpperCase()}`
 * as a comma-separated provider list. Returns an empty array when the env
 * var is missing or empty.
 */
export function envChainResolver(env: Record<string, unknown>): (task: string) => string[] {
	return (task: string) => {
		const key = `AI_CHAIN_${task.toUpperCase()}`;
		const raw = env[key];
		if (typeof raw !== 'string' || !raw) return [];
		return raw.split(',').map((s) => s.trim()).filter(Boolean);
	};
}

/**
 * v0.17: D1-backed chain resolver with per-isolate cache. Reads an
 * `(task, chain)` override from a table (default `ai_provider_overrides`),
 * falling back to a secondary resolver (typically `envChainResolver(env)`)
 * when no row exists for the task.
 *
 * The cache lives per Cloudflare Workers isolate (module-scoped Map). Rows
 * fetched from D1 are memoized for `cacheMs` (default 60s) — hot-path calls
 * are one Map lookup, not a D1 query. Any live update to the overrides table
 * takes effect within `cacheMs` on every isolate.
 *
 * Table shape (create this migration in your consumer — the framework does
 * NOT ship it because column names / ownership vary):
 *
 *   CREATE TABLE ai_provider_overrides (
 *     task    TEXT PRIMARY KEY,
 *     chain   TEXT NOT NULL,           -- comma-separated provider names
 *     updated_at TEXT DEFAULT CURRENT_TIMESTAMP
 *   );
 *
 * Usage:
 *
 *   const router = new AIRouter({
 *     providers,
 *     resolveChain: createD1ChainResolver({
 *       db: env.DB,
 *       fallback: envChainResolver(env),
 *       cacheMs: 60_000,
 *     }),
 *     ...
 *   });
 */
export interface CreateD1ChainResolverOptions {
	/**
	 * D1Database or Drizzle client. The resolver only needs `prepare().bind().first()`,
	 * so a raw `D1Database` works fine.
	 */
	db: { prepare(query: string): { bind(...v: unknown[]): { first<T>(): Promise<T | null> } } };
	/**
	 * Secondary resolver — used when no D1 row exists for a task. Typical:
	 * `envChainResolver(env)`. Absent → the D1 miss yields `[]` and the
	 * router returns `errorKind: 'config'`.
	 */
	fallback?: (task: string) => readonly string[] | Promise<readonly string[]>;
	/** Table name. Default `ai_provider_overrides`. */
	tableName?: string;
	/** Column holding the task label. Default `task`. */
	taskColumn?: string;
	/** Column holding the comma-separated chain. Default `chain`. */
	chainColumn?: string;
	/** Cache TTL in ms. Default 60_000 (60s). Set 0 to disable cache. */
	cacheMs?: number;
	/** Injectable clock for tests. */
	now?: () => number;
}

export function createD1ChainResolver(opts: CreateD1ChainResolverOptions): (task: string) => Promise<string[]> {
	const {
		db,
		fallback,
		tableName = 'ai_provider_overrides',
		taskColumn = 'task',
		chainColumn = 'chain',
		cacheMs = 60_000,
		now = () => Date.now(),
	} = opts;
	// Validate identifiers — this SQL isn't parameterizable, so refuse anything with weird chars.
	for (const [n, v] of Object.entries({ tableName, taskColumn, chainColumn })) {
		if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(v)) {
			throw new Error(`createD1ChainResolver: ${n} must be a bare identifier ([A-Za-z_][A-Za-z0-9_]*)`);
		}
	}
	const cache = new Map<string, { chain: string[]; expiresAt: number }>();
	const sql = `SELECT ${chainColumn} AS chain FROM ${tableName} WHERE ${taskColumn} = ? LIMIT 1`;

	return async (task: string): Promise<string[]> => {
		const nowMs = now();
		const cached = cache.get(task);
		if (cached && cached.expiresAt > nowMs) return cached.chain;
		let chain: string[] | null = null;
		try {
			const row = await db.prepare(sql).bind(task).first<{ chain: string | null }>();
			if (row && typeof row.chain === 'string' && row.chain.trim()) {
				chain = row.chain.split(',').map((s) => s.trim()).filter(Boolean);
			}
		} catch (e) {
			console.log(`[createD1ChainResolver] D1 read failed for task=${task}: ${e instanceof Error ? e.message : String(e)}`);
		}
		if (!chain && fallback) {
			const fb = await fallback(task);
			chain = Array.from(fb);
		}
		chain = chain ?? [];
		if (cacheMs > 0) cache.set(task, { chain, expiresAt: nowMs + cacheMs });
		return chain;
	};
}
