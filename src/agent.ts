/**
 * Agent — front-of-house composer for a WhatsApp bot on Cloudflare Workers.
 */
import { WhatsAppClient } from './client/whatsapp.js';
import { extractInbound } from './webhook/extract.js';
import { handleVerifyChallenge, verifyMetaSignature } from './webhook/verify.js';
import { D1CoalesceQueue, type BatchInfo, type D1QueueOptions } from './queue/d1_coalesce_queue.js';
import { CommandRouter, type CommandHandler } from './router/command_router.js';
import { ButtonRouter, type ButtonHandler } from './router/button_router.js';
import { SessionStore } from './session/session_store.js';
import { MessageLog } from './session/message_log.js';
import { LeadStore } from './lead/lead_store.js';
import { MessageWindow } from './window/message_window.js';
import type { TierProvider } from './gate/tier_provider.js';
import type { AccessGate } from './gate/access_gate.js';
import type { OnboardingFlow } from './flow/onboarding.js';
import type { AIClient, ButtonsPayload, CtaUrlPayload, HandlerContext, ReplyHelper, SummarizerLike, InboundEnvelope, InboundMessage } from './types.js';

export interface AgentOptions {
	whatsapp: {
		endpoint: string;
		token: string;
		verifyToken?: string;
		appSecret?: string;
	};
	db: D1Database;
	ai?: AIClient | null;
	summarizer?: SummarizerLike | null;
	summarizeOver?: number;
	tierProvider?: TierProvider | null;
	gate?: AccessGate | null;
	onboarding?: OnboardingFlow | null;
	stores?: {
		session?: SessionStore;
		log?: MessageLog;
		leads?: LeadStore;
		window?: MessageWindow;
	};
	queue?: Partial<Omit<D1QueueOptions, 'db'>>;
	contextHook?: ((ctx: HandlerContext) => Promise<Record<string, unknown>>) | null;
}

type Lifecycle = 'onFirstContact' | 'onMessage' | 'onError';

export class Agent {
	readonly client: WhatsAppClient;
	readonly db: D1Database;
	readonly queue: D1CoalesceQueue;
	readonly session: SessionStore;
	readonly log: MessageLog;
	readonly leads: LeadStore;
	readonly window: MessageWindow;
	readonly commands = new CommandRouter<HandlerContext>();
	readonly buttons = new ButtonRouter<HandlerContext>();

	readonly verifyToken: string | null;
	readonly appSecret: string | null;
	readonly ai: AIClient | null;
	readonly summarizer: SummarizerLike | null;
	readonly summarizeOver: number;
	readonly tierProvider: TierProvider | null;
	readonly gate: AccessGate | null;
	readonly onboarding: OnboardingFlow | null;
	readonly _lifecycleHooks: Record<Lifecycle, Array<(payload: unknown) => void | Promise<void>>> = {
		onFirstContact: [],
		onMessage: [],
		onError: [],
	};
	readonly _cronJobs = new Map<string, (args: { env: unknown; ctx: ExecutionContext; agent: Agent }) => void | Promise<void>>();
	readonly contextHook: ((ctx: HandlerContext) => Promise<Record<string, unknown>>) | null;

	constructor(opts: AgentOptions) {
		const {
			whatsapp,
			db,
			ai = null,
			summarizer = null,
			summarizeOver = 1024,
			tierProvider = null,
			gate = null,
			onboarding = null,
			stores = {},
			queue = {},
			contextHook = null,
		} = opts;

		if (!whatsapp?.endpoint || !whatsapp?.token) {
			throw new Error('Agent: whatsapp.endpoint + whatsapp.token required');
		}
		if (!db) throw new Error('Agent: db (D1) required');

		this.client = new WhatsAppClient({ endpoint: whatsapp.endpoint, token: whatsapp.token });
		this.verifyToken = whatsapp.verifyToken ?? null;
		this.appSecret = whatsapp.appSecret ?? null;
		this.db = db;
		this.ai = ai;
		this.summarizer = summarizer;
		this.summarizeOver = summarizeOver;
		this.tierProvider = tierProvider;
		this.gate = gate;
		this.onboarding = onboarding;

		this.queue = new D1CoalesceQueue({ db, ...queue });
		this.session = stores.session ?? new SessionStore({ db });
		this.log = stores.log ?? new MessageLog({ db });
		this.leads = stores.leads ?? new LeadStore({ db });
		this.window = stores.window ?? new MessageWindow({ db });
		this.contextHook = contextHook;

		this.buttons.exact('opt-in', async (ctx) => {
			await this.leads.optIn(ctx.user.whatsapp);
			await ctx.reply.text('You are opted in. ✓');
		});
		this.buttons.exact('opt-out', async (ctx) => {
			await this.leads.optOut(ctx.user.whatsapp);
			await ctx.reply.text('You are opted out.');
		});
	}

	command(aliases: string | string[], handler: CommandHandler<HandlerContext>): this {
		this.commands.command(aliases, handler);
		return this;
	}

	onText(handler: CommandHandler<HandlerContext>): this {
		this.commands.fallback(handler);
		return this;
	}

	buttonPrefix(prefix: string, handler: ButtonHandler<HandlerContext>): this {
		this.buttons.prefix(prefix, handler);
		return this;
	}

	button(id: string, handler: ButtonHandler<HandlerContext>): this {
		this.buttons.exact(id, handler);
		return this;
	}

	on(event: Lifecycle, handler: (payload: unknown) => void | Promise<void>): this {
		this._lifecycleHooks[event].push(handler);
		return this;
	}

	cron(pattern: string, handler: (args: { env: unknown; ctx: ExecutionContext; agent: Agent }) => void | Promise<void>): this {
		this._cronJobs.set(pattern, handler);
		return this;
	}

	verifyChallenge(args: { mode?: string | null; token?: string | null; challenge?: string | null }) {
		return handleVerifyChallenge({ ...args, expectedToken: this.verifyToken });
	}

	async verifySignature(rawBody: ArrayBuffer | Uint8Array, header: string | null | undefined): Promise<boolean> {
		if (!this.appSecret) return true;
		return verifyMetaSignature(this.appSecret, rawBody, header);
	}

	async enqueue(envelope: InboundEnvelope): Promise<boolean> {
		return await this.queue.enqueue(envelope);
	}

	async drain(): Promise<number> {
		return await this.queue.processAll((batch) => this.handleBatch(batch));
	}

	async handleBatch({ envelope, combinedText }: BatchInfo): Promise<void> {
		const inbound = extractInbound(envelope);
		if (inbound.kind !== 'message') return;
		if (combinedText && inbound.type === 'text') {
			(inbound as { text: string }).text = combinedText;
		}

		const ctx = await this.buildContext(inbound);
		await this.runLifecycle('onMessage', ctx);

		try {
			await this.dispatch(ctx);
		} catch (err) {
			console.error('[Agent] dispatch error:', err instanceof Error ? err.stack || err.message : err);
			await this.runLifecycle('onError', { ...ctx, error: err });
		}
	}

	private async dispatch(ctx: HandlerContext): Promise<void> {
		const { inbound } = ctx;

		if ('subtype' in inbound && inbound.subtype === 'button_reply') {
			await this.buttons.dispatch(inbound.buttonId, ctx);
			return;
		}
		if ('subtype' in inbound && inbound.subtype === 'template_button') {
			await this.buttons.dispatch(inbound.buttonPayload, ctx);
			return;
		}
		if ('subtype' in inbound && inbound.subtype === 'list_reply') {
			await this.buttons.dispatch(inbound.listId, ctx);
			return;
		}

		if (inbound.type === 'text' || (inbound.type === 'audio' && ctx.text)) {
			await this.commands.dispatch(ctx.text, ctx);
		}
	}

	private async buildContext(inbound: InboundMessage): Promise<HandlerContext> {
		const lead = await this.leads.get(inbound.whatsapp);
		const isNew = !lead;
		await this.leads.upsert({
			whatsapp: inbound.whatsapp,
			ctwaClid: inbound.referral?.ctwa_clid ?? null,
			adData: inbound.referral ?? null,
		});
		await this.window.start(inbound.whatsapp, inbound.fromAd ? 'free' : 'paid');
		await this.log.logInbound({
			wamid: inbound.wamid,
			whatsapp: inbound.whatsapp,
			type: inbound.type,
			payload: inbound.raw,
		});

		if (isNew) {
			if (this.onboarding) await this.onboarding.greet(inbound.whatsapp, { name: inbound.name });
			await this.runLifecycle('onFirstContact', { inbound });
		}

		const session = await this.session.get(inbound.whatsapp);
		const reply = this.replyHelper(inbound.whatsapp, inbound.wamid);

		const ctx: HandlerContext = {
			inbound,
			user: { whatsapp: inbound.whatsapp, name: inbound.name, lead: lead as Record<string, unknown> | null },
			session: session as Record<string, unknown> | null,
			text: inbound.text ?? '',
			reply,
			db: this.db,
			client: this.client,
			ai: this.ai,
			summarizer: this.summarizer,
			window: this.window,
			leads: this.leads,
			log: this.log,
			tier: this.tierProvider,
			gate: this.gate,
			isFirstContact: isNew,
			fromAd: !!inbound.fromAd,
		};

		if (this.contextHook) {
			Object.assign(ctx, await this.contextHook(ctx));
		}
		return ctx;
	}

	private replyHelper(whatsapp: string, inboundWamid: string): ReplyHelper {
		const c = this.client;
		const self = this;
		return {
			text: (body: string, opts?: { previewUrl?: boolean }) => c.sendText(whatsapp, body, opts),
			buttons: (data: ButtonsPayload) => c.sendButtons(whatsapp, data),
			cta: (data: CtaUrlPayload) => c.sendCtaUrl(whatsapp, data),
			image: (data: { url: string; caption?: string }) => c.sendImageUrl(whatsapp, data),
			video: (data: { url: string; caption?: string }) => c.sendVideoUrl(whatsapp, data),
			audio: (data: { url: string }) => c.sendAudioUrl(whatsapp, data),
			template: (data: { name: string; language?: string; components?: unknown[] }) => c.sendTemplate(whatsapp, data),
			markRead: () => c.markRead(inboundWamid),
			ai: async (text, opts) => {
				if (!self.ai) throw new Error('Agent: no AI configured');
				const { answer, threadId: newTid } = await self.ai.chat({ threadId: opts?.threadId ?? null, text });
				await self.session.set(whatsapp, { threadId: newTid });

				let outgoing = answer;
				const long = !!answer && answer.length > self.summarizeOver;
				if (long && self.summarizer && answer) {
					const summary = await self.summarizer.summarize(answer);
					if (summary) outgoing = summary;
				}

				await self.log.updateAnswer(inboundWamid, { body: text, response: answer, summary: outgoing });
				if (outgoing) await c.sendText(whatsapp, outgoing);

				if (long && self.summarizer) {
					await c.sendButtons(whatsapp, {
						body: 'Want the full answer?',
						buttons: [{ id: `expand_${inboundWamid}`, title: 'Show full answer' }],
					});
				}
				return { answer, threadId: newTid };
			},
		};
	}

	private async runLifecycle(name: Lifecycle, payload: unknown): Promise<void> {
		for (const h of this._lifecycleHooks[name]) {
			try {
				await h(payload);
			} catch (e) {
				console.error(`[Agent] lifecycle ${name}:`, e instanceof Error ? e.message : e);
			}
		}
	}

	async scheduled(event: ScheduledEvent, env: unknown, ctx: ExecutionContext): Promise<void> {
		ctx.waitUntil(this.queue.processAll((b) => this.handleBatch(b)));
		ctx.waitUntil(this.queue.cleanup());

		const handler = this._cronJobs.get(event.cron);
		if (handler) {
			await handler({ env, ctx, agent: this });
		}
	}
}
