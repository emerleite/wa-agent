/**
 * support-bot — focused wa-agent example for AI-driven support.
 *
 * Designed as the next step after `echo-bot` and a smaller surface than
 * `full-bot`. It exercises just three primitives:
 *
 *   - Pipeline: intent → policy → LLM → audit, with one custom predicate
 *     that escalates any message containing a phone number.
 *   - ReplyEnricher: every AI answer ends with a tagged "More help" CTA.
 *   - Tier gate: free users hit the AccessGate and never reach the LLM.
 *
 * No cron jobs, no broadcasts, no plans. Just inbound → AI → reply.
 */
import { Hono } from 'hono';
import { AzureOpenAI } from 'openai';
import {
	Agent,
	mountWebhook,
	OpenAIAssistant,
	Summarizer,
	HttpTierProvider,
	AccessGate,
	LLMIntentClassifier,
	PolicyGate,
	defaultPipeline,
	AuditEmitter,
	LayeredReplyEnricher,
	createUtmTagger,
	honoRateLimit,
	KvRateLimitStore,
	RateLimit,
} from 'wa-agent';

const tagWa = createUtmTagger({ source: 'whatsapp' });

let app, agent;

function init(env) {
	if (app) return;
	app = new Hono();

	const azure = new AzureOpenAI({
		endpoint: env.AZURE_OPENAI_ENDPOINT,
		apiKey: env.AZURE_OPENAI_API_KEY,
		apiVersion: env.AZURE_API_VERSION,
		deployment: env.AZURE_MODEL_DEPLOYMENT,
	});
	const assistant = new OpenAIAssistant({ client: azure, assistantId: env.ASSISTANT_ID });
	const summarizer = new Summarizer({ client: azure, model: 'gpt-4o-mini' });

	// Tier gating — free users get a CTA + opt-out, paid users get the AI.
	const tierProvider = new HttpTierProvider({ baseUrl: env.BILLING_API_URL, token: env.BILLING_API_TOKEN });
	const gate = new AccessGate({ tierProvider, allowedTiers: ['premium', 'lifetime'], freeMessageLimit: 0 });

	// Pipeline: intent classifier (stub for example), one policy guard, audit.
	const classifier = new LLMIntentClassifier({
		intents: ['question', 'cancel', 'pricing', 'other'],
		fallback: 'other',
		classify: async (text) => {
			const t = text.toLowerCase();
			if (/cancel|unsubscribe/.test(t)) return { intent: 'cancel', confidence: 0.9 };
			if (/price|cost|plan/.test(t)) return { intent: 'pricing', confidence: 0.8 };
			if (/\?$/.test(t)) return { intent: 'question', confidence: 0.7 };
			return { intent: 'other', confidence: 0.4 };
		},
	});
	const phoneRegex = /\+?\d[\d\s().-]{8,}/;
	const policy = new PolicyGate({
		accessGate: gate,
		predicates: [
			// Escalate anything with a phone number — those belong with a human.
			(ctx) => (phoneRegex.test(ctx.text) ? { proceed: false, reason: 'contains_phone_number', action: 'escalate' } : null),
		],
	});

	// Append a tagged CTA to every AI answer (idempotent on re-runs).
	const replyEnricher = new LayeredReplyEnricher({
		layers: [
			(answer) =>
				answer.includes('utm_source=whatsapp')
					? answer
					: `${answer.trim()}\n\n_Need more?_ ${tagWa('https://example.com/help', 'support_reply')}`,
		],
	});

	agent = new Agent({
		whatsapp: {
			endpoint: env.META_WA_ENDPOINT,
			token: env.META_WA_TOKEN,
			verifyToken: env.META_WH_TOKEN,
			appSecret: env.META_APP_SECRET,
		},
		db: env.DB,
		ai: assistant,
		summarizer,
		tierProvider,
		replyEnricher,
		events: { env },
		pipeline: defaultPipeline({
			ai: assistant,
			summarizer,
			intent: classifier,
			policy,
			emit: () => Promise.resolve(), // re-bound below
			modelName: 'openai-assistant',
		}),
	});
	agent.pipeline.replaceStep('audit', new AuditEmitter({ emit: agent.emit }));

	agent.command(['help', 'h', '?'], async ({ reply }) => {
		await reply.text('Ask me anything! For pricing or cancellations, just type the word.');
	});
	agent.command(['stop'], async ({ user, leads, reply }) => {
		await leads.optOut(user.whatsapp);
		await reply.text('You have been opted out.');
	});
	agent.onText(async ({ text, user, reply, inbound, log }) => {
		await reply.markRead();
		const session = await agent.session.get(user.whatsapp);

		// `inReplyToWamid` is set when the user used WhatsApp's "reply to
		// message" UI on a previous bot reply. Use it to feed the prior
		// answer back as additional context for clarification turns.
		let prompt = text;
		if (inbound.inReplyToWamid) {
			const prev = await log.byWamid(inbound.inReplyToWamid);
			if (prev?.response) {
				prompt = `[The user is replying to my earlier message:\n"${prev.response.slice(0, 400)}"]\n\nUser: ${text}`;
			}
		}

		await reply.ai(prompt, { threadId: session?.threadId });
	});

	// Rate-limit the inbound webhook BEFORE the agent's signature check.
	// 60 hits / minute per IP × path is generous for a single tenant; tune
	// per traffic shape. Fail-open on KV outage matches the framework
	// `Blocklist` policy.
	app.use(
		'/wa/webhook',
		honoRateLimit(
			new RateLimit({
				store: new KvRateLimitStore({ kv: env.KV, prefix: 'rl:support-webhook' }),
				windowSeconds: 60,
				max: 60,
			}),
		),
	);

	mountWebhook(agent, app);
}

export default {
	fetch: (req, env, ctx) => {
		init(env);
		return app.fetch(req, env, ctx);
	},
	scheduled: (event, env, ctx) => {
		init(env);
		return agent.scheduled(event, env, ctx);
	},
};
