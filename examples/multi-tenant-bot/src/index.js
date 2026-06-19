/**
 * multi-tenant-bot — BSP-style routing example.
 *
 * One Worker serves many WhatsApp numbers. Each tenant has its own
 * `phone_number_id`, its own AI assistant, and its own escalation policy.
 * The framework's `MultiTenantAgentRegistry` (v0.6+) handles the
 * envelope→tenant→Agent routing; `drainAll` (v0.7+) drives the queue from
 * a single cron trigger.
 *
 * Tenant config lives in two places:
 *   1. A `tenants` D1 table — id, phone_number_id, agent_mode, etc.
 *   2. A KV namespace `wa:phone:<phone_number_id>` → tenantId, for
 *      sub-millisecond resolution of the inbound webhook.
 *
 * Replace the stub `loadTenantConfig` with your own data layer.
 */
import { Hono } from 'hono';
import {
	Agent,
	EscalationStore,
	honoRateLimit,
	KvRateLimitStore,
	MultiTenantAgentRegistry,
	mountMultiTenantWebhook,
	OpenAIAssistant,
	RateLimit,
} from 'wa-agent';
import { AzureOpenAI } from 'openai';

let app, registry;

function init() {
	if (app) return;
	app = new Hono();

	// Per-tenant Agent factory. Closes over `env` for KV / D1 access.
	const buildAgent = async (env, tenantId) => {
		const tenant = await loadTenantConfig(env, tenantId);

		const azure = new AzureOpenAI({
			endpoint: env.AZURE_OPENAI_ENDPOINT,
			apiKey: env.AZURE_OPENAI_API_KEY,
			apiVersion: env.AZURE_API_VERSION,
			deployment: tenant.modelDeployment, // varies per tenant
		});
		const assistant = new OpenAIAssistant({ client: azure, assistantId: tenant.assistantId });

		// One escalation store per tenant — same physical `escalations` table,
		// scoped by `tenantId` so each tenant's dashboard sees only its rows.
		const escalationStore = new EscalationStore({ db: env.DB });

		const agent = new Agent({
			whatsapp: {
				// Each tenant has its own phone_number_id. App secret may be
				// App-global (Meta Tech Provider) or per-tenant.
				endpoint: `https://graph.facebook.com/v22.0/${tenant.phoneNumberId}`,
				token: env.META_SYSTEM_USER_TOKEN,
				verifyToken: env.META_WH_TOKEN,
				appSecret: env.META_APP_SECRET,
			},
			db: env.DB,
			ai: assistant,
			escalationStore,
			tenantId, // ← wires v0.6 queue scoping so per-tenant drains stay isolated
			mode: tenant.agentMode || 'autonomous',
			events: { env, tenantId },
		});

		agent.onText(async ({ text, reply }) => {
			await reply.markRead();
			await reply.ai(text);
		});

		return agent;
	};

	registry = new MultiTenantAgentRegistry({
		// phone_number_id from the envelope → tenantId via KV (sub-ms read).
		resolveTenantId: async (env, envelope) => {
			const value = envelope?.entry?.[0]?.changes?.[0]?.value;
			const phoneNumberId = value?.metadata?.phone_number_id;
			if (!phoneNumberId) return null;
			return await env.KV.get(`wa:phone:${phoneNumberId}`);
		},
		buildAgent,
		// Verify-challenge tenant — Meta's verify token is App-global, so any
		// tenant's Agent.verifyChallenge() answers. Return null when no
		// tenants are onboarded yet (responds 503).
		// v0.7: drainAll enumerates every tenant for the cron-driven queue
		// drain. Real apps page through their tenant table.
		enumerateTenants: async (env) => {
			const r = await env.DB.prepare('SELECT id FROM tenants').all();
			return (r.results ?? []).map((t) => t.id);
		},
		onUnknownTenant: (_env, envelope) => {
			const pid = envelope?.entry?.[0]?.changes?.[0]?.value?.metadata?.phone_number_id;
			console.warn('[multi-tenant-bot] unknown tenant:', pid ?? '(missing phone_number_id)');
		},
	});

	// Rate-limit BEFORE tenant resolution — otherwise an unknown-number flood
	// burns KV reads. 60/min per IP × path is generous for one tenant; tune.
	app.use('/wa/webhook', async (c, next) =>
		honoRateLimit(
			new RateLimit({
				store: new KvRateLimitStore({ kv: c.env.KV, prefix: 'rl:mt-webhook' }),
				windowSeconds: 60,
				max: 60,
			}),
		)(c, next),
	);

	mountMultiTenantWebhook(registry, app, '/wa', {
		anyTenantForVerify: async (env) => {
			const r = await env.DB.prepare('SELECT id FROM tenants LIMIT 1').first();
			return r?.id ?? null;
		},
	});
}

// Stub tenant config loader — replace with your KV/D1 lookup. In production
// this would be cached via KV with a TTL (the registry's MemoryAgentCache
// shortcuts subsequent reads on the warm path).
async function loadTenantConfig(env, tenantId) {
	const cached = await env.KV.get(`tenant:${tenantId}`, 'json');
	if (cached) return cached;
	const row = await env.DB.prepare(
		'SELECT phone_number_id, model_deployment, assistant_id, agent_mode FROM tenants WHERE id = ?',
	)
		.bind(tenantId)
		.first();
	if (!row) throw new Error(`tenant ${tenantId} not found`);
	const config = {
		phoneNumberId: row.phone_number_id,
		modelDeployment: row.model_deployment,
		assistantId: row.assistant_id,
		agentMode: row.agent_mode,
	};
	await env.KV.put(`tenant:${tenantId}`, JSON.stringify(config), { expirationTtl: 60 * 5 });
	return config;
}

export default {
	fetch: (req, env, ctx) => {
		init();
		return app.fetch(req, env, ctx);
	},
	// Cron: drain every tenant's queue. The framework schedules each tenant's
	// drain via `waitUntil` so they run in parallel within the cron budget.
	scheduled: async (_event, env, ctx) => {
		init();
		const result = await registry.drainAll(env, (p) => ctx.waitUntil(p));
		console.log('[multi-tenant-bot] drained', result.scheduled, 'tenants');
	},
};
