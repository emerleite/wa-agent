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
