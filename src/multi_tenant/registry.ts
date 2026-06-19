/**
 * Multi-tenant Agent routing.
 *
 * Wraps the "envelope → tenantId → Agent" routing pattern that BSP-style
 * apps already write by hand. The single-tenant `Agent` + `mountWebhook`
 * API is unchanged; this is a sibling, opt-in.
 *
 *   const registry = new MultiTenantAgentRegistry({
 *     resolveTenantId: async (env, envelope) => {
 *       const phoneNumberId = envelope.entry?.[0]?.changes?.[0]?.value?.metadata?.phone_number_id;
 *       if (!phoneNumberId) return null;
 *       return await env.KV.get(`wa:phone:${phoneNumberId}`);
 *     },
 *     buildAgent: async (env, tenantId) => {
 *       const tenant = await loadTenantConfig(env, tenantId);
 *       return new Agent({
 *         whatsapp: { endpoint: tenant.metaEndpoint, token: tenant.metaToken, appSecret: tenant.appSecret },
 *         db: env.DB,
 *         ai: buildAI(tenant),
 *         mode: tenant.agentMode,
 *         escalationStore: tenant.escalationStore,
 *         tenantId,
 *       });
 *     },
 *   });
 *
 *   mountMultiTenantWebhook(registry, app, '/wa');
 *
 * Per-isolate `Map` agent cache by default (no TTL — isolate lifetime
 * covers the cache lifetime, and tenant config rarely changes mid-isolate).
 * Pass a custom `agentCache` for LRU / TTL semantics.
 *
 * Queue table is shared across tenants — `message_queue.message_id` is
 * globally unique because Meta's wamids are globally unique. No
 * per-tenant schema migration needed.
 */
import type { Agent } from '../agent.js';
import type { InboundEnvelope } from '../types.js';

export interface AgentCache {
	get(tenantId: string): Agent | null;
	set(tenantId: string, agent: Agent): void;
}

export interface MultiTenantAgentRegistryOptions {
	/**
	 * Resolve the inbound envelope to a tenantId. Return `null` when the
	 * envelope is for an unknown tenant (typically: a `phone_number_id`
	 * not present in your tenant store). `onUnknownTenant` fires in that
	 * case so apps can log / alert / emit.
	 *
	 * Receives the bot env so KV/D1 lookups are easy.
	 */
	resolveTenantId: (env: unknown, envelope: InboundEnvelope) => Promise<string | null> | string | null;
	/**
	 * Build a fully-configured Agent for `tenantId`. Called once per cache
	 * miss; the result is stashed in `agentCache`. Synchronous returns are
	 * accepted for in-memory configs.
	 */
	buildAgent: (env: unknown, tenantId: string) => Promise<Agent> | Agent;
	/**
	 * Per-isolate Agent cache. Default: in-memory Map, no TTL — the isolate
	 * lifetime covers the lifetime of any practical tenant config. Pass
	 * `null` to disable caching (rebuild every turn — useful for tests).
	 */
	agentCache?: AgentCache | null;
	/**
	 * Called when `resolveTenantId` returns null. Default: console.warn.
	 * Use to emit telemetry, count unknown-number hits, etc.
	 */
	onUnknownTenant?: (env: unknown, envelope: InboundEnvelope) => void | Promise<void>;
	/**
	 * Enumerate every tenantId the bot serves. Used by `drainAll` (v0.7+)
	 * to schedule per-tenant queue drains from a single cron trigger. The
	 * scheduled cron handler typically delegates to this so the registry
	 * can iterate without each app re-implementing the lookup.
	 *
	 *   enumerateTenants: async (env) => {
	 *     const r = await env.DB.prepare('SELECT id FROM tenants').all<{ id: string }>();
	 *     return (r.results ?? []).map(t => t.id);
	 *   }
	 *
	 * Apps that paginate (hundreds of tenants) extend this signature later
	 * — v0.7 ships the simple version.
	 */
	enumerateTenants?: (env: unknown) => Promise<string[]> | string[];
}

/**
 * In-memory `AgentCache` — the default. Cache is per-isolate and never
 * evicts; Cloudflare's isolate-recycling policy bounds the size.
 */
export class MemoryAgentCache implements AgentCache {
	private readonly map = new Map<string, Agent>();

	get(tenantId: string): Agent | null {
		return this.map.get(tenantId) ?? null;
	}

	set(tenantId: string, agent: Agent): void {
		this.map.set(tenantId, agent);
	}

	/** Test helper — clears all cached agents. */
	clear(): void {
		this.map.clear();
	}

	/** Number of cached agents. */
	get size(): number {
		return this.map.size;
	}
}

export class MultiTenantAgentRegistry {
	readonly resolveTenantId: MultiTenantAgentRegistryOptions['resolveTenantId'];
	readonly buildAgent: MultiTenantAgentRegistryOptions['buildAgent'];
	readonly agentCache: AgentCache | null;
	readonly onUnknownTenant: (env: unknown, envelope: InboundEnvelope) => void | Promise<void>;
	readonly enumerateTenants: ((env: unknown) => Promise<string[]> | string[]) | null;

	constructor(opts: MultiTenantAgentRegistryOptions) {
		if (!opts.resolveTenantId) throw new Error('MultiTenantAgentRegistry: resolveTenantId required');
		if (!opts.buildAgent) throw new Error('MultiTenantAgentRegistry: buildAgent required');
		this.resolveTenantId = opts.resolveTenantId;
		this.buildAgent = opts.buildAgent;
		// `null` opts out of caching entirely; `undefined` falls back to the
		// memory default. Tests use the null path to assert build cost.
		this.agentCache = opts.agentCache === null ? null : opts.agentCache ?? new MemoryAgentCache();
		this.onUnknownTenant = opts.onUnknownTenant ?? defaultOnUnknownTenant;
		this.enumerateTenants = opts.enumerateTenants ?? null;
	}

	/**
	 * Iterate every tenant from `enumerateTenants`, resolve each Agent
	 * (cache-friendly), and schedule `drain() + queue.cleanup()` via
	 * `waitUntil`. Designed for `Worker.scheduled(event, env, ctx)`:
	 *
	 *   scheduled: (event, env, ctx) =>
	 *     registry.drainAll(env, (p) => ctx.waitUntil(p))
	 *
	 * `enumerateTenants` MUST be configured at construction or this throws —
	 * the registry has no other way to know which tenants exist. Apps that
	 * paginate (hundreds of tenants) should override per-batch in v0.8.
	 *
	 * Per-tenant failures are caught and logged so one bad tenant doesn't
	 * stop the cron from draining the rest. The return value reports how
	 * many drains were scheduled, useful for cron-handler logs / metrics.
	 */
	async drainAll(env: unknown, waitUntil: (p: Promise<unknown>) => void): Promise<{ scheduled: number }> {
		if (!this.enumerateTenants) {
			throw new Error(
				'MultiTenantAgentRegistry.drainAll: enumerateTenants must be configured at construction',
			);
		}
		let tenantIds: string[];
		try {
			tenantIds = await this.enumerateTenants(env);
		} catch (e) {
			console.error('[MultiTenantAgentRegistry] enumerateTenants threw:', e instanceof Error ? e.message : e);
			return { scheduled: 0 };
		}
		let scheduled = 0;
		for (const tenantId of tenantIds) {
			try {
				const agent = await this.agentFor(env, tenantId);
				waitUntil(
					(async () => {
						try {
							await agent.drain();
							await agent.queue.cleanup();
						} catch (e) {
							console.error(`[MultiTenantAgentRegistry] drain ${tenantId} failed:`, e instanceof Error ? e.message : e);
						}
					})(),
				);
				scheduled += 1;
			} catch (e) {
				console.error(`[MultiTenantAgentRegistry] agentFor ${tenantId} failed:`, e instanceof Error ? e.message : e);
			}
		}
		return { scheduled };
	}

	/**
	 * Resolve + cache the Agent for the given tenantId.
	 *
	 * Returns the freshly-built or cached Agent. Failures from `buildAgent`
	 * propagate — callers should catch + log them.
	 */
	async agentFor(env: unknown, tenantId: string): Promise<Agent> {
		if (!tenantId) throw new Error('MultiTenantAgentRegistry.agentFor: tenantId required');
		if (this.agentCache) {
			const cached = this.agentCache.get(tenantId);
			if (cached) return cached;
		}
		const built = await this.buildAgent(env, tenantId);
		if (this.agentCache) this.agentCache.set(tenantId, built);
		return built;
	}

	/**
	 * Resolve the tenant from an envelope and return the corresponding Agent.
	 * Returns `null` when the tenant can't be resolved — caller can decide
	 * whether to reject the request, queue it for later, or silently drop.
	 */
	async agentForEnvelope(env: unknown, envelope: InboundEnvelope): Promise<Agent | null> {
		const tenantId = await this.resolveTenantId(env, envelope);
		if (!tenantId) {
			try {
				await this.onUnknownTenant(env, envelope);
			} catch (e) {
				console.error('[MultiTenantAgentRegistry] onUnknownTenant threw:', e instanceof Error ? e.message : e);
			}
			return null;
		}
		return await this.agentFor(env, tenantId);
	}

	/**
	 * Full inbound flow: resolve tenant → build Agent → enqueue + schedule
	 * a drain. Returns `{ ok, tenantId, enqueued }` for the caller's
	 * response.
	 *
	 * Use the Hono helper `mountMultiTenantWebhook` instead when possible;
	 * this is the bare-fetch escape hatch.
	 */
	async handleEnvelope(
		env: unknown,
		envelope: InboundEnvelope,
		waitUntil: (p: Promise<unknown>) => void,
	): Promise<{ ok: boolean; tenantId: string | null; enqueued: boolean }> {
		const tenantId = await this.resolveTenantId(env, envelope);
		if (!tenantId) {
			try {
				await this.onUnknownTenant(env, envelope);
			} catch (e) {
				console.error('[MultiTenantAgentRegistry] onUnknownTenant threw:', e instanceof Error ? e.message : e);
			}
			return { ok: false, tenantId: null, enqueued: false };
		}
		const agent = await this.agentFor(env, tenantId);
		const enqueued = await agent.enqueue(envelope);
		if (enqueued) {
			waitUntil(
				(async () => {
					await new Promise((r) => setTimeout(r, agent.queue.debounceSeconds * 1000));
					await agent.drain();
				})(),
			);
		}
		return { ok: true, tenantId, enqueued };
	}
}

function defaultOnUnknownTenant(_env: unknown, envelope: InboundEnvelope): void {
	// `metadata` isn't on the typed envelope shape (Meta sends it but we
	// don't model it because most code paths don't care). Cast to read it
	// for diagnostic logging only.
	const value = envelope?.entry?.[0]?.changes?.[0]?.value as
		| { metadata?: { phone_number_id?: string } }
		| undefined;
	const phoneNumberId = value?.metadata?.phone_number_id;
	console.warn('[MultiTenantAgentRegistry] unknown tenant for phone_number_id:', phoneNumberId ?? '(missing)');
}

// ---- Hono integration ----

interface HonoLike {
	get(path: string, handler: (c: HonoContextLike) => unknown): unknown;
	post(path: string, handler: (c: HonoContextLike) => unknown): unknown;
}

interface HonoContextLike {
	req: {
		query(name: string): string | undefined;
		header(name: string): string | undefined;
		arrayBuffer(): Promise<ArrayBuffer>;
	};
	executionCtx: { waitUntil(promise: Promise<unknown>): void };
	env: { DB: D1Database; [k: string]: unknown };
	text(body: string): unknown;
	json(body: unknown, status?: number): unknown;
}

export interface MountMultiTenantWebhookOptions {
	/**
	 * Resolve any tenant whose Agent's `verifyChallenge` should answer the
	 * GET handshake from Meta. Meta's verify token is App-global by default,
	 * so any tenant's Agent suffices — pick the first one you can find.
	 *
	 * Receives the env so KV/D1 lookups work. Return `null` when the app
	 * has no tenants yet (returns 503).
	 */
	anyTenantForVerify: (env: unknown) => Promise<string | null> | string | null;
}

/**
 * Hono integration — multi-tenant variant of `mountWebhook`.
 *
 *   mountMultiTenantWebhook(registry, app, '/wa', {
 *     anyTenantForVerify: async (env) => firstTenantId(env),
 *   });
 *
 * - `GET /webhook` resolves *any* onboarded tenant (the verify token is
 *   App-global) and delegates challenge-answer to its Agent. Apps with no
 *   tenants yet get a 503.
 * - `POST /webhook` resolves the tenant from the envelope, verifies the
 *   signature against THAT tenant's Agent (per-tenant `appSecret`), then
 *   enqueues. Unknown tenants return 404 + fire `onUnknownTenant`.
 *
 * **Layer `honoRateLimit` BEFORE this** so unknown-number floods don't burn
 * tenant-resolution KV lookups.
 */
export function mountMultiTenantWebhook(
	registry: MultiTenantAgentRegistry,
	app: HonoLike,
	base: string = '/wa',
	opts: MountMultiTenantWebhookOptions,
): void {
	const url = (p: string) => `${base}${p}`;

	app.get(url('/webhook'), async (c) => {
		const tenantId = await opts.anyTenantForVerify(c.env);
		if (!tenantId) return c.json({ error: 'no_tenant_configured' }, 503);
		const agent = await registry.agentFor(c.env, tenantId);
		const result = agent.verifyChallenge({
			mode: c.req.query('hub.mode'),
			token: c.req.query('hub.verify_token'),
			challenge: c.req.query('hub.challenge'),
		});
		return result.ok && result.challenge ? c.text(result.challenge) : c.json({ error: 'Invalid' }, 403);
	});

	app.post(url('/webhook'), async (c) => {
		const raw = await c.req.arrayBuffer();
		let envelope: InboundEnvelope;
		try {
			envelope = JSON.parse(new TextDecoder().decode(raw));
		} catch {
			return c.json({ error: 'bad_json' }, 400);
		}

		const tenantId = await registry.resolveTenantId(c.env, envelope);
		if (!tenantId) {
			try {
				await registry.onUnknownTenant(c.env, envelope);
			} catch (e) {
				console.error('[MultiTenantAgentRegistry] onUnknownTenant threw:', e instanceof Error ? e.message : e);
			}
			return c.json({ error: 'unknown_tenant' }, 404);
		}

		const agent = await registry.agentFor(c.env, tenantId);

		// Signature verification AFTER tenant resolution because appSecret may
		// be per-tenant. For App-global signing this is the same outcome but
		// one extra KV lookup; the precedence (rate-limit before lookup)
		// makes that cost negligible at scale.
		const valid = await agent.verifySignature(raw, c.req.header('X-Hub-Signature-256'));
		if (!valid) return c.json({ error: 'Invalid signature' }, 403);

		const enqueued = await agent.enqueue(envelope);
		if (enqueued) {
			c.executionCtx.waitUntil(
				(async () => {
					await new Promise((r) => setTimeout(r, agent.queue.debounceSeconds * 1000));
					await agent.drain();
				})(),
			);
		}
		return c.text('OK');
	});
}
