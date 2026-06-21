/**
 * Per-provider circuit breaker — three-state machine (CLOSED → OPEN →
 * HALF_OPEN → CLOSED). Sits in front of `AIRouter`'s provider calls so a
 * down provider stops eating wall-clock budget on every turn.
 *
 * State is in-isolate (per-Worker-instance `Map`). Workers recycle every
 * few minutes, so breakers self-heal without needing KV-shared state.
 * Trade-off: a provider that's actually down won't propagate OPEN across
 * isolates, so each cold isolate pays one failure to learn. Acceptable
 * for the typical Workers fleet size.
 *
 * Thresholds are per error kind:
 * - `'429'` (rate limit) trips fast, recovers fast
 * - `'5xx'` / `'network'` / `'parse'` trip slower, recover slower
 *   (provider really down)
 * - `'timeout'` sits in between
 *
 * Exponential backoff: each consecutive trip after the first doubles the
 * OPEN window, capped at `backoffMaxMs` per error bucket. The counter
 * resets to 0 once the breaker closes successfully (HALF_OPEN passes
 * `halfOpenSuccessesToClose` probes).
 */

export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';
export type CircuitErrorKind = '429' | '5xx' | 'network' | 'timeout' | 'parse';

export interface CircuitBucketConfig {
	/** Failures of this kind, in `windowMs`, that trip the breaker. */
	threshold: number;
	/** Rolling window over which failures are counted. */
	windowMs: number;
	/** Initial OPEN duration (doubles on consecutive trips). */
	openMs: number;
	/** Hard cap on the exponentially-backed-off OPEN duration. */
	backoffMaxMs: number;
}

export interface CircuitBreakerConfig {
	rateLimit: CircuitBucketConfig;
	serverError: CircuitBucketConfig;
	timeout: CircuitBucketConfig;
	/** Successful probes in HALF_OPEN needed to fully CLOSE the breaker. */
	halfOpenSuccessesToClose: number;
}

export interface CircuitMetrics {
	status: CircuitState;
	openMsRemaining: number;
	openCount: number;
	recentFailures: number;
}

const DEFAULTS: CircuitBreakerConfig = {
	rateLimit: { threshold: 3, windowMs: 30_000, openMs: 30_000, backoffMaxMs: 300_000 },
	serverError: { threshold: 5, windowMs: 60_000, openMs: 180_000, backoffMaxMs: 1_800_000 },
	timeout: { threshold: 3, windowMs: 30_000, openMs: 60_000, backoffMaxMs: 600_000 },
	halfOpenSuccessesToClose: 2,
};

const ERROR_BUCKETS: Record<CircuitErrorKind, keyof Omit<CircuitBreakerConfig, 'halfOpenSuccessesToClose'>> = {
	'429': 'rateLimit',
	'5xx': 'serverError',
	network: 'serverError',
	timeout: 'timeout',
	parse: 'serverError',
};

interface FailureRecord {
	at: number;
	bucket: keyof Omit<CircuitBreakerConfig, 'halfOpenSuccessesToClose'>;
}

interface BreakerEntry {
	status: CircuitState;
	failures: FailureRecord[];
	openedAt: number;
	openMs: number;
	consecutiveOpenCount: number;
	halfOpenSuccesses: number;
}

export class CircuitBreaker {
	readonly config: CircuitBreakerConfig;
	readonly now: () => number;
	private readonly entries = new Map<string, BreakerEntry>();

	constructor(config: Partial<CircuitBreakerConfig> = {}, now: () => number = () => Date.now()) {
		this.config = { ...DEFAULTS, ...config };
		this.now = now;
	}

	/**
	 * @returns true if a call to `provider` is allowed (CLOSED or HALF_OPEN,
	 * or an OPEN window that has expired and gets promoted to HALF_OPEN).
	 *
	 * Side-effectful: an expired OPEN entry is transitioned to HALF_OPEN
	 * here so the next call can probe.
	 */
	canCall(provider: string): boolean {
		const e = this.entry(provider);
		if (e.status === 'CLOSED' || e.status === 'HALF_OPEN') return true;
		const now = this.now();
		if (now >= e.openedAt + e.openMs) {
			e.status = 'HALF_OPEN';
			e.halfOpenSuccesses = 0;
			return true;
		}
		return false;
	}

	/** Current status (may transition OPEN → HALF_OPEN as a side effect). */
	stateOf(provider: string): CircuitState {
		this.canCall(provider);
		return this.entry(provider).status;
	}

	recordSuccess(provider: string): void {
		const e = this.entry(provider);
		if (e.status === 'HALF_OPEN') {
			e.halfOpenSuccesses += 1;
			if (e.halfOpenSuccesses >= this.config.halfOpenSuccessesToClose) {
				e.status = 'CLOSED';
				e.failures = [];
				e.consecutiveOpenCount = 0;
				e.openedAt = 0;
				e.openMs = 0;
				e.halfOpenSuccesses = 0;
			}
			return;
		}
		// CLOSED success: drop old failures opportunistically (60s window).
		const now = this.now();
		e.failures = e.failures.filter((f) => now - f.at < 60_000);
	}

	recordFailure(provider: string, errorKind: CircuitErrorKind | string): void {
		const e = this.entry(provider);
		const bucket = ERROR_BUCKETS[errorKind as CircuitErrorKind] ?? 'serverError';
		const cfg = this.config[bucket];
		const now = this.now();

		if (e.status === 'HALF_OPEN') {
			// Probe failed — back to OPEN with exponential backoff.
			e.consecutiveOpenCount += 1;
			e.status = 'OPEN';
			e.openedAt = now;
			e.openMs = Math.min(cfg.openMs * Math.pow(2, e.consecutiveOpenCount - 1), cfg.backoffMaxMs);
			e.halfOpenSuccesses = 0;
			return;
		}

		// CLOSED: accumulate failures, trip if same-bucket threshold reached in window.
		e.failures.push({ at: now, bucket });
		e.failures = e.failures.filter((f) => now - f.at < cfg.windowMs);
		const sameBucket = e.failures.filter((f) => f.bucket === bucket).length;
		if (sameBucket >= cfg.threshold) {
			e.status = 'OPEN';
			e.openedAt = now;
			e.consecutiveOpenCount = 1;
			e.openMs = cfg.openMs;
			e.failures = [];
		}
	}

	/** Snapshot of every provider's current circuit state — for dashboards. */
	metrics(): Record<string, CircuitMetrics> {
		const out: Record<string, CircuitMetrics> = {};
		const now = this.now();
		for (const [provider, e] of this.entries) {
			out[provider] = {
				status: e.status,
				openMsRemaining: e.status === 'OPEN' ? Math.max(0, e.openedAt + e.openMs - now) : 0,
				openCount: e.consecutiveOpenCount,
				recentFailures: e.failures.length,
			};
		}
		return out;
	}

	/** Force-reset one provider (admin / test only). */
	reset(provider: string): void {
		this.entries.delete(provider);
	}

	/** Drop every cached entry (test helper). */
	clear(): void {
		this.entries.clear();
	}

	private entry(provider: string): BreakerEntry {
		let e = this.entries.get(provider);
		if (!e) {
			e = {
				status: 'CLOSED',
				failures: [],
				openedAt: 0,
				openMs: 0,
				consecutiveOpenCount: 0,
				halfOpenSuccesses: 0,
			};
			this.entries.set(provider, e);
		}
		return e;
	}
}
