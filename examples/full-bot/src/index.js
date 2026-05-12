/**
 * full-bot — wa-agent showcasing every primitive in one Worker.
 *
 * Features:
 *   - First-contact OnboardingFlow (contact card + opt-in button + help text)
 *   - Tier check via HttpTierProvider + AccessGate
 *   - Premium-gated AI assistant via Azure OpenAI
 *   - Throttled Upsell (sendSmart picks full pitch vs reminder by funnel state)
 *   - UsageCounter logs blocked attempts for conversion-funnel analytics
 *   - PreferenceStore for delivery_mode (text / audio / both)
 *   - Auto-summarization of long answers (with "expand" button)
 *   - Audio messages: Whisper transcription → forward to AI
 *   - Daily devotional broadcast at 9am UTC (text + R2-cached TTS audio)
 *   - Daily yes/no re-engagement at noon UTC ("Did you read today?")
 *   - 21-day SequentialPlan with Done/Skip buttons (deliver at 6am UTC)
 *   - Slot-based content (one per slot, weighted, deduped) at 14h UTC
 *   - HybridSearch over a `docs` table (verses, FAQs, etc.)
 *
 * Replace the "TODO" content with your own seed data.
 */
import { Hono } from 'hono';
import { AzureOpenAI } from 'openai';
import {
	Agent,
	mountWebhook,
	OpenAIAssistant,
	Summarizer,
	Transcriber,
	Broadcast,
	ReEngagement,
	SequentialPlan,
	SlotDelivery,
	R2Cache,
	AzureTTS,
	stripMarkdown,
	OnboardingFlow,
	HttpTierProvider,
	AccessGate,
	Upsell,
	UsageCounter,
	PreferenceStore,
	definePreference,
	HybridSearch,
	WhatsAppClient,
} from 'wa-agent';

// Typed preference for delivery format
const deliveryMode = definePreference('delivery_mode', 'both', ['text', 'audio', 'both']);

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

	// Pluggable tier check (free / premium / lifetime) → AccessGate
	const tierProvider = new HttpTierProvider({
		baseUrl: env.BILLING_API_URL,
		token: env.BILLING_API_TOKEN,
	});

	// Build a WhatsAppClient once and reuse for OnboardingFlow + Upsell.
	// The Agent will build an equivalent internal client from the same config.
	const client = new WhatsAppClient({ endpoint: env.META_WA_ENDPOINT, token: env.META_WA_TOKEN });

	const onboarding = new OnboardingFlow({
		client,
		welcomeBody: ({ name }) => `Hi ${name || 'there'}! Tap below to start.`,
		helpText: 'Type "help" any time to see what I can do.',
	});

	agent = new Agent({
		whatsapp: {
			endpoint: env.META_WA_ENDPOINT,
			token: env.META_WA_TOKEN,
			verifyToken: env.META_WH_TOKEN,
			appSecret: env.META_APP_SECRET,
		},
		db: env.DB,
		ai: new OpenAIAssistant({ client: azure, assistantId: env.ASSISTANT_ID }),
		summarizer: new Summarizer({ client: azure, model: 'gpt-4o-mini' }),
		tierProvider,
		onboarding,
	});

	const transcriber = new Transcriber({ client: azure });
	const usage = new UsageCounter({ db: agent.db });
	const prefs = new PreferenceStore({ db: agent.db });

	// AI is premium-only; cap-free users hit the gate and see the Upsell.
	const gate = new AccessGate({ tierProvider, allowedTiers: ['premium', 'lifetime'], freeMessageLimit: 0 });

	const upsell = new Upsell({
		client,
		leads: agent.leads,
		funnelState: 'CHECKOUT',
		pitch: 'Subscribe to keep chatting with the AI assistant. Free features stay free.',
		ctaText: 'Subscribe',
		ctaUrl: async (whatsapp) => `${env.BILLING_API_URL}/checkout/${whatsapp}`,
		video: env.PITCH_VIDEO_URL ? { url: env.PITCH_VIDEO_URL, caption: 'See how it works' } : null,
		reminder: { pitch: 'Tap below to subscribe — free features (verses, plans, devotionals) stay free.' },
	});

	// ---- Commands ----
	agent.command(['help', 'h', '?'], async ({ reply }) => {
		await reply.text(helpText);
	});

	agent.command(['preferences', 'configurar'], async ({ reply }) => {
		await reply.buttons({
			body: 'How would you like to receive content?',
			buttons: [
				{ id: 'pref_mode_text', title: '📝 Text only' },
				{ id: 'pref_mode_audio', title: '🎧 Audio only' },
				{ id: 'pref_mode_both', title: '✨ Both' },
			],
		});
	});

	agent.command(['plan', 'plans'], async ({ user, reply }) => {
		const plans = new SequentialPlan({ db: agent.db });
		const enrolled = await plans.getActiveEnrollment(user.whatsapp);
		if (enrolled) {
			await reply.text(`You're on day ${enrolled.currentDay} of "${enrolled.title}".`);
			return;
		}
		const list = await plans.listActivePlans();
		if (!list.length) {
			await reply.text('No plans available.');
			return;
		}
		await reply.text(list.map((p, i) => `${i + 1}. ${p.title} — ${p.durationDays} days`).join('\n'));
		await reply.buttons({
			body: 'Pick a plan to start:',
			buttons: list.slice(0, 3).map((p) => ({ id: `plan_enroll_${p.id}`, title: p.title.slice(0, 17) })),
		});
	});

	// ---- Search before AI: hybrid lookup against a `docs` table ----
	const search = new HybridSearch({ db: agent.db, contentTable: 'docs', searchColumns: ['title', 'body'] });

	// ---- Default text handler: search → tier-gate → AI ----
	agent.onText(async ({ text, inbound, user, reply }) => {
		// Audio: transcribe first
		let prompt = text;
		if (inbound.type === 'audio' && inbound.audioId) {
			// Premium-only: don't pay Whisper for free users.
			const access = await gate.check(user.whatsapp);
			if (!access.allowed) {
				await usage.record(user.whatsapp, 'audio_gate_blocked');
				await reply.text('Audio messages need a subscription. Send text and I\'ll respond.');
				await upsell.sendSmart(user.whatsapp);
				return;
			}
			const stream = await agent.client.downloadMedia(inbound.audioId);
			prompt = (await transcriber.transcribe(stream)) || '';
		}
		if (!prompt) {
			await reply.text('Sorry, I could not understand that.');
			return;
		}

		// 1. Try local search first (free for everyone)
		const hits = await search.search(prompt, { limit: 1 });
		if (hits.length) {
			await reply.text(hits[0].body);
			return;
		}

		// 2. AI (premium only)
		const access = await gate.check(user.whatsapp);
		if (!access.allowed) {
			await usage.record(user.whatsapp, 'ai_gate_blocked');
			await upsell.sendSmart(user.whatsapp);
			return;
		}

		await reply.markRead();
		const session = await agent.session.get(user.whatsapp);
		await reply.ai(prompt, { threadId: session?.threadId });
	});

	// ---- Buttons ----
	agent.buttonPrefix('expand_', async ({ suffix, log, reply }) => {
		const row = await log.byWamid(suffix);
		if (row?.response) await reply.text(row.response);
	});

	agent.buttonPrefix('pref_mode_', async ({ user, suffix, reply }) => {
		const ok = await deliveryMode.set(prefs, user.whatsapp, suffix);
		await reply.text(ok ? `✓ Saved: ${suffix}` : 'Could not save preference.');
	});

	agent.buttonPrefix('plan_enroll_', async ({ user, suffix, reply }) => {
		const plans = new SequentialPlan({ db: agent.db });
		await plans.enroll(user.whatsapp, parseInt(suffix, 10));
		await reply.text('Enrolled! Day 1 arrives tomorrow morning.');
	});

	agent.buttonPrefix('plan_done_', async ({ user, suffix, reply }) => {
		const [planId, day] = suffix.split('_').map(Number);
		const plans = new SequentialPlan({ db: agent.db });
		const r = await plans.markDone(user.whatsapp, planId, day);
		await reply.text(r.completed ? 'Plan complete! 🎉' : `Day ${day} done. See you tomorrow.`);
	});

	agent.buttonPrefix('plan_skip_', async ({ user, suffix, reply }) => {
		const [planId, day] = suffix.split('_').map(Number);
		const plans = new SequentialPlan({ db: agent.db });
		const r = await plans.skipDay(user.whatsapp, planId, day);
		await reply.text(r.completed ? 'Plan complete!' : `Skipped day ${day}.`);
	});

	// ---- ReEngagement answers ----
	const reading = new ReEngagement({
		client: agent.client,
		db: agent.db,
		topicId: 1,
		question: { body: 'Did you read your devotional yesterday?', yesLabel: 'Yes ✅', noLabel: 'No ❌' },
	});
	agent.buttonPrefix('engagement_1_', async ({ user, buttonId, reply }) => {
		await reading.recordAnswer(user.whatsapp, buttonId);
		const week = await reading.weekProgress(user.whatsapp);
		const summary = week.map((d) => (d.answer === 'a' ? '✅' : d.answer === 'b' ? '❌' : '⬜')).join(' ');
		await reply.text(`Got it!\nThis week: ${summary}`);
	});

	// ---- Cron jobs ----
	agent.cron('0 9 * * *', async ({ env }) => {
		// Daily devotional + audio (respects delivery_mode preference per-user)
		const today = await env.DB.prepare(`SELECT id, content, audio_url FROM devotional WHERE date = date('now')`).first();
		if (!today) return;

		// Lazily generate audio if missing
		if (!today.audio_url && env.TTS_BUCKET && env.TTS_PUBLIC_HOST) {
			const tts = new AzureTTS({ key: env.AZURE_SPEECH_KEY, region: env.AZURE_SPEECH_REGION, voice: 'en-US-AriaNeural', language: 'en-US' });
			const cache = new R2Cache({ bucket: env.TTS_BUCKET, publicHost: env.TTS_PUBLIC_HOST });
			const { url } = await cache.getOrCreate(`devotional/${new Date().toISOString().slice(0, 10)}.mp3`, async () => ({
				body: await tts.synthesize(stripMarkdown(today.content)),
				contentType: 'audio/mpeg',
			}));
			await env.DB.prepare(`UPDATE devotional SET audio_url = ? WHERE id = ?`).bind(url, today.id).run();
			today.audio_url = url;
		}

		const broadcast = new Broadcast({ client: agent.client, db: agent.db, channel: 'devotional' });
		await broadcast.run({
			send: async ({ whatsapp }) => {
				const mode = await deliveryMode.get(prefs, whatsapp);
				let ok = true;
				if (mode === 'text' || mode === 'both') {
					ok = await agent.client.sendText(whatsapp, today.content);
				}
				if (ok && today.audio_url && (mode === 'audio' || mode === 'both')) {
					await agent.client.sendAudioUrl(whatsapp, { url: today.audio_url });
				}
				return ok;
			},
		});
	});

	agent.cron('0 12 * * *', async () => {
		const broadcast = new Broadcast({ client: agent.client, db: agent.db, channel: 'engagement_reading' });
		await broadcast.run({ send: ({ whatsapp }) => reading.ask(whatsapp) });
	});

	agent.cron('0 6 * * *', async () => {
		// Sequential plan delivery
		const plans = new SequentialPlan({ db: agent.db });
		await plans.autoAdvanceStale();
		const users = await plans.usersForDelivery();
		for (const u of users) {
			const day = await plans.getDay(u.planId, u.currentDay);
			if (!day) continue;
			await agent.client.sendText(u.whatsapp, `📖 Day ${u.currentDay}/${u.durationDays} — ${day.title}\n\n${day.content}`);
			await agent.client.sendButtons(u.whatsapp, {
				body: 'When you finish, let me know:',
				buttons: [
					{ id: `plan_done_${u.planId}_${u.currentDay}`, title: '✅ Done' },
					{ id: `plan_skip_${u.planId}_${u.currentDay}`, title: '⏭ Skip' },
				],
			});
			await plans.markDelivered(u.whatsapp, u.planId, u.currentDay);
		}
	});

	agent.cron('0 14 * * *', async () => {
		// Slot-based delivery (afternoon tip/ad)
		const slot = new SlotDelivery({ db: agent.db });
		const users = await slot.usersForSlot('afternoon');
		for (const u of users) {
			const item = await slot.pickForUser(u.whatsapp);
			if (!item) continue;
			if (item.cta_url && item.cta_text) {
				await agent.client.sendCtaUrl(u.whatsapp, { body: item.body, displayText: item.cta_text, url: item.cta_url });
			} else {
				await agent.client.sendText(u.whatsapp, item.body);
			}
			await slot.recordImpression(u.whatsapp, item.id, 'afternoon');
		}
	});

	mountWebhook(agent, app);
}

const helpText = `Hi! I'm a wa-agent demo bot.
- Type anything to chat (premium)
- Send a verse reference / question for free lookup
- "plan" — see content plans
- "configurar" — set delivery preference
- "stop" — opt out`;

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
