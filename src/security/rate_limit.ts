/**
 * Sliding-window rate limit.
 *
 * Scope: cheap protection for unauthenticated webhook surfaces (Meta inbound,
 * billing-gateway callbacks, admin endpoints). The shape: per key, count the
 * number of hits in the last N seconds; reject when the count crosses `max`.
 *
 * Storage is pluggable via `RateLimitStore`. Ship two implementations:
 *
 *   - `KvRateLimitStore({ kv, prefix })` — durable across isolates, the right
 *     default for Workers. Writes use `waitUntil`-friendly TTL.
 *   - `MemoryRateLimitStore()` — per-isolate Map. For tests; also fine for
 *     coarse single-isolate caps where exact accuracy doesn't matter.
 *
 * Hono integration:
 *
 *   const limiter = new RateLimit({
 *     store: new KvRateLimitStore({ kv: env.KV, prefix: 'rl:webhook' }),
 *     windowSeconds: 60,
 *     max: 30,
 *   });
 *   app.post('/webhook', honoRateLimit(limiter), webhookHandler);
 *
 * Out of scope: distributed Redis, leaky-bucket smoothing, IP geolocation.
 * If you need any of that, plug in a custom store. The contract is small —
 * `get(key) → number[]` + `put(key, hits, ttlSeconds) → void`.
 */
import type { MiddlewareHandler } from 'hono';

export interface RateLimitStore {
	get(key: string): Promise<number[]>;
	put(key: string, hits: number[], ttlSeconds: number): Promise<void>;
}

export interface RateLimitResult {
	allowed: boolean;
	/** Hit count inside the current window AFTER this check (decremented on reject). */
	count: number;
	/** Seconds the caller should wait before retrying. 0 when allowed. */
	retryAfter: number;
}

export interface RateLimitOptions {
	store: RateLimitStore;
	/** Rolling window in seconds. */
	windowSeconds: number;
	/** Max hits allowed inside the window. */
	max: number;
}

export class RateLimit {
	readonly store: RateLimitStore;
	readonly windowSeconds: number;
	readonly max: number;

	constructor({ store, windowSeconds, max }: RateLimitOptions) {
		if (!store) throw new Error('RateLimit: store required');
		if (!Number.isFinite(windowSeconds) || windowSeconds <= 0) {
			throw new Error('RateLimit: windowSeconds must be a positive number');
		}
		if (!Number.isFinite(max) || max < 0) throw new Error('RateLimit: max must be a non-negative number');
		this.store = store;
		this.windowSeconds = windowSeconds;
		this.max = max;
	}

	/**
	 * Check + record. Returns `{ allowed, count, retryAfter }`. Persists the
	 * new hit only when `allowed` is true. Failure-safe: a store throw is
	 * treated as "allowed" (fail-open) so a KV outage can't take the bot
	 * down — the same policy as `Blocklist`.
	 */
	async check(key: string): Promise<RateLimitResult> {
		try {
			const now = Math.floor(Date.now() / 1000);
			const windowStart = now - this.windowSeconds;
			const raw = await this.store.get(key);
			const recent = raw.filter((t) => t >= windowStart);

			if (recent.length >= this.max) {
				const oldest = recent[0] ?? now;
				const retryAfter = Math.max(1, this.windowSeconds - (now - oldest));
				return { allowed: false, count: recent.length, retryAfter };
			}

			recent.push(now);
			// Double the TTL so an item near the window's edge survives until
			// the window has rolled past it — guards against under-counting
			// across KV-eventual-consistency windows.
			await this.store.put(key, recent, this.windowSeconds * 2);
			return { allowed: true, count: recent.length, retryAfter: 0 };
		} catch (e) {
			console.error('[RateLimit] store error, failing open:', e instanceof Error ? e.message : e);
			return { allowed: true, count: 0, retryAfter: 0 };
		}
	}
}

// ---- KV-backed store ----

export interface KvRateLimitStoreOptions {
	kv: KVNamespace;
	prefix?: string;
}

export class KvRateLimitStore implements RateLimitStore {
	readonly kv: KVNamespace;
	readonly prefix: string;

	constructor({ kv, prefix = 'rl' }: KvRateLimitStoreOptions) {
		if (!kv) throw new Error('KvRateLimitStore: kv required');
		this.kv = kv;
		this.prefix = prefix;
	}

	private fullKey(key: string): string {
		return `${this.prefix}:${key}`;
	}

	async get(key: string): Promise<number[]> {
		const raw = await this.kv.get<{ hits?: number[] }>(this.fullKey(key), 'json');
		if (!raw || !Array.isArray(raw.hits)) return [];
		return raw.hits.filter((t): t is number => typeof t === 'number');
	}

	async put(key: string, hits: number[], ttlSeconds: number): Promise<void> {
		// expirationTtl must be ≥ 60 per Workers docs — clamp short windows up.
		const expirationTtl = Math.max(60, Math.ceil(ttlSeconds));
		await this.kv.put(this.fullKey(key), JSON.stringify({ hits }), { expirationTtl });
	}
}

// ---- Memory store (tests + single-isolate) ----

export class MemoryRateLimitStore implements RateLimitStore {
	private readonly map = new Map<string, { hits: number[]; expiresAt: number }>();

	async get(key: string): Promise<number[]> {
		const entry = this.map.get(key);
		if (!entry) return [];
		if (entry.expiresAt <= Date.now() / 1000) {
			this.map.delete(key);
			return [];
		}
		return [...entry.hits];
	}

	async put(key: string, hits: number[], ttlSeconds: number): Promise<void> {
		this.map.set(key, { hits: [...hits], expiresAt: Math.floor(Date.now() / 1000) + ttlSeconds });
	}

	/** Test helper — clears all keys. */
	clear(): void {
		this.map.clear();
	}
}

// ---- Hono middleware ----

export interface HonoRateLimitOptions {
	/** Override the key extractor. Default: `cf-connecting-ip + req.path`. */
	keyFn?: (c: HonoRateLimitContext) => string;
	/**
	 * Override the on-reject response. Default: `c.json({ error: 'rate_limited',
	 * retry_after_seconds }, 429)`.
	 */
	onReject?: (c: HonoRateLimitContext, result: RateLimitResult) => Response | Promise<Response>;
}

/** Subset of the Hono context the middleware touches. */
export interface HonoRateLimitContext {
	req: { header(name: string): string | undefined; path: string };
	json(body: unknown, status?: number): Response;
}

/**
 * Hono middleware that runs `limit.check(keyFn(c))` before the handler.
 *
 * Default key: `cf-connecting-ip + req.path`. Default reject: a 429 with
 * `{ error: 'rate_limited', retry_after_seconds }`. Both overridable.
 */
export function honoRateLimit(
	limit: RateLimit,
	{ keyFn, onReject }: HonoRateLimitOptions = {},
): MiddlewareHandler {
	const extractKey = keyFn ?? defaultKeyFn;
	const reject =
		onReject ??
		((c, result) =>
			c.json(
				{ error: 'rate_limited', retry_after_seconds: result.retryAfter },
				429,
			));

	return async (c, next) => {
		const result = await limit.check(extractKey(c as unknown as HonoRateLimitContext));
		if (!result.allowed) {
			return reject(c as unknown as HonoRateLimitContext, result);
		}
		await next();
	};
}

function defaultKeyFn(c: HonoRateLimitContext): string {
	const ip = c.req.header('cf-connecting-ip') ?? 'unknown';
	return `${ip}:${c.req.path}`;
}
