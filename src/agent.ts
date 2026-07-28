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
import { normalizeDb, type DB } from './db/client.js';
import type { TierProvider } from './gate/tier_provider.js';
import type { AccessGate } from './gate/access_gate.js';
import type { OnboardingFlow } from './flow/onboarding.js';
import { makeEmit, type Emit, type EventsBindings } from './events/emit.js';
import type { AgentPipeline } from './pipeline/pipeline.js';
import type { PipelineContext } from './pipeline/types.js';
import type { Blocklist } from './security/blocklist.js';
import { asEnricher, type ReplyEnricher, type ReplyEnricherFn } from './ai/reply_enricher.js';
import type { EscalateArgs, EscalationStore, EscalationUrgency } from './escalate/escalation_store.js';
import type { AgentReviewQueue } from './review/review_queue.js';
import type { AgentMode, AIClient, ButtonsPayload, CtaUrlPayload, HandlerContext, ReplyHelper, SummarizerLike, InboundEnvelope, InboundMessage } from './types.js';

export interface AgentOptions {
	whatsapp: {
		endpoint: string;
		token: string;
		verifyToken?: string;
		appSecret?: string;
	};
	/**
	 * D1 binding OR a pre-built Drizzle client. v0.7+: foreign Drizzle
	 * clients (typed against another schema) are accepted and rebound
	 * against the framework schema internally — see `normalizeDb`.
	 */
	db: D1Database | DB;
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
	/**
	 * Wire framework events to Cloudflare Analytics Engine. Pass `{ env }` to
	 * pick up `env.EVENTS`; omit to silently no-op (useful for local dev or
	 * bots that don't ship telemetry). `tenantId` flows through every emitted
	 * event for multi-tenant SaaS use.
	 */
	events?: { env: EventsBindings; tenantId?: string };
	/**
	 * Composable agent pipeline (intent → policy → LLM → audit). When set,
	 * `reply.ai(text)` routes the turn through this pipeline instead of
	 * calling `AIClient.chat()` directly. Backward-compatible: omit to keep
	 * the simple direct-chat path from v0.1.
	 */
	pipeline?: AgentPipeline | null;
	/** Optional tenantId stamped on every per-turn pipeline context. */
	tenantId?: string;
	/**
	 * Abuse blocklist. When set, every inbound message is checked against it
	 * before any handler runs. Blocked messages are silently dropped (no
	 * lifecycle hooks fire); they ARE logged + emit an `error` event tagged
	 * `source: 'blocklist'` for triage.
	 */
	blocklist?: Blocklist | null;
	/**
	 * Post-LLM enrichment applied inside `reply.ai()` before the answer is
	 * sent and logged. Runs on both the long answer and the summary, so any
	 * appended footer survives summarization. Pass `null` (default) to skip.
	 *
	 * Use cases: append citation footers, CTA links, UTM-tagged URLs, or
	 * affiliate-suffixes for free-tier users. Plain functions are accepted
	 * for inline cases (no class needed).
	 */
	replyEnricher?: ReplyEnricher | ReplyEnricherFn | null;
	/**
	 * Persist + (optionally) fan out escalations from the pipeline. When a
	 * pipeline decision has `action: 'escalate'` and this is set, the Agent
	 * records the escalation in D1 before sending the (possibly null) reply.
	 * Manual `escalationStore.record({...})` calls from handlers also work.
	 */
	escalationStore?: EscalationStore | null;
	/**
	 * Default urgency when the pipeline doesn't supply one. Default 'medium'.
	 * Override per-app for noisier (low) or pre-escalated (high) defaults.
	 */
	escalationDefaultUrgency?: EscalationUrgency;
	/**
	 * Transform the auto-record `EscalateArgs` before they reach
	 * `escalationStore.record(...)`. Sync or async. Use this to augment the
	 * framework defaults with app-specific data the Agent doesn't model:
	 *
	 *   onEscalate: async (args, ctx) => {
	 *     const patientId = await resolvePatient(args.whatsapp, ctx.tenantId);
	 *     return { ...args, extraColumns: { patient_id: patientId } };
	 *   }
	 *
	 * Closes the v0.6 gap where apps with rich escalation schemas (psico's
	 * `patient_id` FK) couldn't use the auto-record path — the framework
	 * had no way to add `extraColumns` to args it constructed.
	 */
	onEscalate?: (args: EscalateArgs, ctx: HandlerContext) => Promise<EscalateArgs> | EscalateArgs;
	/**
	 * Queue-and-approve store for `assisted` mode. When set + `mode === 'assisted'`,
	 * `reply.ai()` enqueues a `pending` row INSTEAD of calling `client.sendText`.
	 * A human-review dashboard reads the rows and acks; the per-tenant cron
	 * `MultiTenantAgentRegistry.dispatchApprovedReviews` (or your own handler)
	 * picks up approved rows and dispatches them.
	 *
	 * Without this option, `assisted` mode still records the AI turn as an
	 * `assisted_review` escalation (v0.5) and sends the answer immediately —
	 * the v0.8 review queue closes the loop by gating the send on approval.
	 *
	 * Single-tenant apps can also subscribe directly to approved rows via
	 * a cron handler that calls `queue.list({ status: 'approved' })`.
	 */
	reviewQueue?: AgentReviewQueue | null;
	/**
	 * Agent rollout stage. `'autonomous'` (default) keeps the framework's
	 * v0.4 behavior. Set a string for a fixed mode across all turns; pass
	 * a function to vary per-turn (typically per-tenant via a tenant
	 * lookup against `ctx.user`):
	 *
	 *   mode: 'shadow'
	 *   mode: async (ctx) => (await tenantStore.get(ctx.tenantId)).mode
	 *
	 * See `AgentMode` for the semantics of each stage.
	 */
	mode?: AgentMode | ((ctx: HandlerContext) => AgentMode | Promise<AgentMode>);
}

type Lifecycle = 'onFirstContact' | 'onMessage' | 'afterReply' | 'onError';

/** Media types `agent.on<Type>` sugar covers (v0.17+). */
export type MediaType = 'image' | 'audio' | 'video' | 'document' | 'sticker' | 'location' | 'contacts';

/**
 * Guard verdict (v0.17). Return `null` to allow dispatch. Return an object to
 * deny — the framework replies with `.reply` (when set) then aborts dispatch.
 * The guard is a good place for paywall / trial / feature-flag / geo checks.
 */
export type GuardVerdict = null | { reply?: string; silent?: boolean };
export type GuardFn = (ctx: HandlerContext) => GuardVerdict | Promise<GuardVerdict>;
export type MediaHandler = (ctx: HandlerContext) => void | Promise<void>;

export class Agent {
	readonly client: WhatsAppClient;
	/** Drizzle ORM client (v0.2+). Use `agent.db.select()/.insert()/...` in handlers. */
	readonly db: DB;
	/** Bound event emitter (no-op when no `events` config was supplied). */
	readonly emit: Emit;
	readonly queue: D1CoalesceQueue;
	readonly session: SessionStore;
	readonly log: MessageLog;
	readonly leads: LeadStore;
	readonly window: MessageWindow;
	readonly commands = new CommandRouter<HandlerContext>();
	readonly buttons = new ButtonRouter<HandlerContext>();
	/** Media-type handlers registered via `agent.on{Image,Audio,Video,Document,Sticker,Location,Contacts}` (v0.17). */
	readonly _mediaHandlers = new Map<MediaType, MediaHandler>();
	/** Pre-dispatch guards registered via `agent.guard(fn)` (v0.17). */
	readonly _guards: GuardFn[] = [];

	readonly verifyToken: string | null;
	readonly appSecret: string | null;
	readonly ai: AIClient | null;
	readonly summarizer: SummarizerLike | null;
	readonly summarizeOver: number;
	readonly tierProvider: TierProvider | null;
	readonly gate: AccessGate | null;
	readonly onboarding: OnboardingFlow | null;
	readonly pipeline: AgentPipeline | null;
	readonly tenantId: string | null;
	readonly blocklist: Blocklist | null;
	readonly replyEnricher: ReplyEnricher | null;
	readonly escalationStore: EscalationStore | null;
	readonly reviewQueue: AgentReviewQueue | null;
	readonly escalationDefaultUrgency: EscalationUrgency;
	readonly onEscalate: ((args: EscalateArgs, ctx: HandlerContext) => Promise<EscalateArgs> | EscalateArgs) | null;
	readonly mode: AgentMode | ((ctx: HandlerContext) => AgentMode | Promise<AgentMode>);
	readonly _lifecycleHooks: Record<Lifecycle, Array<(payload: unknown) => void | Promise<void>>> = {
		onFirstContact: [],
		onMessage: [],
		afterReply: [],
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
			events = undefined,
			pipeline = null,
			tenantId = null,
			blocklist = null,
			replyEnricher = null,
			escalationStore = null,
			escalationDefaultUrgency = 'medium',
			onEscalate = null,
			reviewQueue = null,
			mode = 'autonomous',
		} = opts;

		if (!whatsapp?.endpoint || !whatsapp?.token) {
			throw new Error('Agent: whatsapp.endpoint + whatsapp.token required');
		}
		if (!db) throw new Error('Agent: db (D1) required');

		this.client = new WhatsAppClient({ endpoint: whatsapp.endpoint, token: whatsapp.token });
		this.verifyToken = whatsapp.verifyToken ?? null;
		this.appSecret = whatsapp.appSecret ?? null;
		this.db = normalizeDb(db);
		this.emit = events ? makeEmit(events) : noOpEmit;
		this.ai = ai;
		this.summarizer = summarizer;
		this.summarizeOver = summarizeOver;
		this.tierProvider = tierProvider;
		this.gate = gate;
		this.onboarding = onboarding;
		this.pipeline = pipeline;
		this.tenantId = tenantId;
		this.blocklist = blocklist;
		this.replyEnricher = replyEnricher ? asEnricher(replyEnricher) : null;
		this.escalationStore = escalationStore;
		this.escalationDefaultUrgency = escalationDefaultUrgency;
		this.onEscalate = onEscalate;
		this.reviewQueue = reviewQueue;
		this.mode = mode;

		// `tenantId` flows into the queue so multi-tenant deployments scope
		// claimBatch / recoverStale / cleanup to this tenant's rows only.
		// Single-tenant agents leave tenantId = null and behave bit-for-bit
		// as in v0.5.
		this.queue = new D1CoalesceQueue({ db: this.db, tenantId, ...queue });
		this.session = stores.session ?? new SessionStore({ db: this.db });
		this.log = stores.log ?? new MessageLog({ db: this.db });
		this.leads = stores.leads ?? new LeadStore({ db: this.db, emit: this.emit });
		this.window = stores.window ?? new MessageWindow({ db: this.db });
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

	/**
	 * Register a handler for a specific media type (v0.17). Pre-v0.17 the only
	 * way to handle non-text inbound was `agent.on('onMessage', ...)` with a
	 * manual `switch (inbound.type)` — every non-text-only bot reimplemented
	 * the switch. This method is sugar over `dispatch()` so consumers write
	 * `agent.onImage(async (ctx) => ...)` and the framework routes correctly.
	 *
	 * When both a media handler AND `agent.on('onMessage', ...)` are set,
	 * BOTH fire (lifecycle hook runs first per the existing contract, then
	 * dispatch picks the media handler).
	 */
	onImage(handler: MediaHandler): this { return this.onMedia('image', handler); }
	onAudio(handler: MediaHandler): this { return this.onMedia('audio', handler); }
	onVideo(handler: MediaHandler): this { return this.onMedia('video', handler); }
	onDocument(handler: MediaHandler): this { return this.onMedia('document', handler); }
	onSticker(handler: MediaHandler): this { return this.onMedia('sticker', handler); }
	onLocation(handler: MediaHandler): this { return this.onMedia('location', handler); }
	onContacts(handler: MediaHandler): this { return this.onMedia('contacts', handler); }

	private onMedia(type: MediaType, handler: MediaHandler): this {
		this._mediaHandlers.set(type, handler);
		return this;
	}

	/**
	 * Register a pre-dispatch guard (v0.17). Runs after `onMessage` lifecycle
	 * hooks and before button/command/media dispatch. Return `null` to allow.
	 * Return `{reply?, silent?}` to deny — the framework sends `reply` (when
	 * set) and short-circuits dispatch for THIS message.
	 *
	 * Guards run in the order they were registered. First denying guard wins;
	 * later guards are not consulted. Errors thrown from a guard are caught
	 * by the outer dispatch try/catch and the message is treated as an
	 * `[Agent] dispatch error` (safest default: fail-closed, no dispatch).
	 *
	 * Distinct from `Blocklist` — Blocklist is a HARD DROP without a reply.
	 * `guard` is a "deny + tell the user why" pattern (paywall, trial, geo).
	 */
	guard(fn: GuardFn): this {
		this._guards.push(fn);
		return this;
	}

	on(event: Lifecycle, handler: (payload: unknown) => void | Promise<void>): this {
		this._lifecycleHooks[event].push(handler);
		return this;
	}

	/**
	 * Sugar for `on('afterReply', ...)` with a typed handler — runs after
	 * the per-message dispatch completes (button / command / fallback) but
	 * before `handleBatch` returns. Use for opportunistic side-channel sends
	 * (reactive ads, contextual tips), analytics nudges, etc. Errors are
	 * caught + logged; they do NOT fail the inbound turn.
	 */
	afterReply(handler: (ctx: HandlerContext) => void | Promise<void>): this {
		this._lifecycleHooks.afterReply.push(handler as (payload: unknown) => void | Promise<void>);
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

		if (this.blocklist && (await this.blocklist.isBlocked(inbound.whatsapp))) {
			console.warn(`[Agent] dropping inbound from blocked ${inbound.whatsapp} (wamid=${inbound.wamid})`);
			await this.emit({
				type: 'error',
				whatsapp: inbound.whatsapp,
				source: 'blocklist',
				message: `dropped inbound wamid=${inbound.wamid}`,
			});
			return;
		}

		const ctx = await this.buildContext(inbound);
		await this.emit({
			type: 'message_inbound',
			whatsapp: inbound.whatsapp,
			wamid: inbound.wamid,
			messageType: inbound.type as 'text' | 'audio' | 'image' | 'button_reply' | 'list_reply' | 'template_button' | 'document' | 'interactive',
			isFirstContact: ctx.isFirstContact,
			fromAd: !!inbound.fromAd,
		});
		await this.runLifecycle('onMessage', ctx);

		try {
			await this.dispatch(ctx);
			await this.runLifecycle('afterReply', ctx);
		} catch (err) {
			console.error('[Agent] dispatch error:', err instanceof Error ? err.stack || err.message : err);
			await this.emit({
				type: 'error',
				whatsapp: inbound.whatsapp,
				source: 'agent.dispatch',
				message: err instanceof Error ? err.message : String(err),
			});
			await this.runLifecycle('onError', { ...ctx, error: err });
		}
	}

	private async dispatch(ctx: HandlerContext): Promise<void> {
		const { inbound } = ctx;

		// v0.17: pre-dispatch guards. First denying verdict wins.
		for (const g of this._guards) {
			const verdict = await g(ctx);
			if (verdict) {
				if (verdict.reply && !verdict.silent) {
					await ctx.reply.text(verdict.reply);
				}
				return;
			}
		}

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
			return;
		}

		// v0.17: media-type handlers (image/audio-without-transcript/video/document/sticker/location/contacts).
		const mediaHandler = this._mediaHandlers.get(inbound.type as MediaType);
		if (mediaHandler) {
			await mediaHandler(ctx);
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

		// Build the ctx without `reply` first so the mode resolver (function
		// form) can read every other field of HandlerContext, then attach the
		// reply helper which carries the resolved mode into reply.ai().
		const partialCtx = {
			inbound,
			user: { whatsapp: inbound.whatsapp, name: inbound.name, lead: lead as Record<string, unknown> | null },
			session: session as Record<string, unknown> | null,
			text: inbound.text ?? '',
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
		const mode = await this.resolveMode(partialCtx as unknown as HandlerContext);
		// Deferred ref so the replyHelper's closures (specifically `reply.ai`'s
		// onEscalate path, v0.7+) can read the fully-assembled ctx when the
		// handler calls them — which always happens AFTER buildContext returns.
		const ctxRef: { current: HandlerContext | null } = { current: null };
		const reply = this.replyHelper(inbound.whatsapp, inbound.wamid, mode, ctxRef);

		const ctx: HandlerContext = {
			...partialCtx,
			reply,
			mode,
		};
		ctxRef.current = ctx;

		if (this.contextHook) {
			Object.assign(ctx, await this.contextHook(ctx));
		}
		return ctx;
	}

	/**
	 * Resolve the configured `mode` (string or function form) into a concrete
	 * `AgentMode` for this turn. Fail-safe: if the resolver throws or returns
	 * an unknown value, falls back to `'autonomous'` and logs.
	 */
	private async resolveMode(ctx: HandlerContext): Promise<AgentMode> {
		const m = this.mode;
		if (typeof m !== 'function') return m;
		try {
			const resolved = await m(ctx);
			if (resolved === 'shadow' || resolved === 'assisted' || resolved === 'operator' || resolved === 'autonomous') {
				return resolved;
			}
			console.warn('[Agent] mode resolver returned unknown value, defaulting to autonomous:', resolved);
			return 'autonomous';
		} catch (e) {
			console.error('[Agent] mode resolver threw, defaulting to autonomous:', e instanceof Error ? e.message : e);
			return 'autonomous';
		}
	}

	private replyHelper(
		whatsapp: string,
		inboundWamid: string,
		mode: AgentMode,
		ctxRef: { current: HandlerContext | null },
	): ReplyHelper {
		const c = this.client;
		const self = this;
		return {
			text: (body: string, opts?: { previewUrl?: boolean; inReplyToWamid?: string | null }) =>
				c.sendText(whatsapp, body, opts),
			replyTo: (wamid: string, body: string, opts?: { previewUrl?: boolean }) =>
				c.sendText(whatsapp, body, { ...opts, inReplyToWamid: wamid }),
			buttons: (data: ButtonsPayload) => c.sendButtons(whatsapp, data),
			cta: (data: CtaUrlPayload) => c.sendCtaUrl(whatsapp, data),
			image: (data: { url: string; caption?: string }) => c.sendImageUrl(whatsapp, data),
			video: (data: { url: string; caption?: string }) => c.sendVideoUrl(whatsapp, data),
			audio: (data: { url: string }) => c.sendAudioUrl(whatsapp, data),
			template: (data: { name: string; language?: string; components?: unknown[] }) => c.sendTemplate(whatsapp, data),
			markRead: () => c.markRead(inboundWamid),
			ai: async (text, opts) => {
				if (self.pipeline) {
					const pipeCtx: PipelineContext = {
						whatsapp,
						text,
						wamid: inboundWamid,
						threadId: opts?.threadId ?? null,
						tenantId: self.tenantId ?? undefined,
						traceId: crypto.randomUUID(),
					};
					// `agent_outcome` pairs with the `agent_decision` emitted by the
					// pipeline's AuditEmitter step via `parentTraceId = pipeCtx.traceId`.
					// 'ok' covers: reply sent, policy chose silent/escalate cleanly.
					// 'error' covers: a pipeline step threw (caught + flagged via
					// `step_error:X` reason), OR the WhatsApp send threw afterwards.
					let outcome: 'ok' | 'error' = 'ok';
					try {
						const decision = await self.pipeline.run(pipeCtx);
						if (typeof decision.reason === 'string' && decision.reason.startsWith('step_error:')) {
							outcome = 'error';
						}
						if (decision.action === 'escalate' && self.escalationStore) {
							// Auto-record the escalation before returning. The reason carries
							// the policy predicate's tag (e.g. 'crisis_regex'); message
							// defaults to the user's text. Urgency comes from the decision
							// when present, else the Agent's default.
							const escalation = (decision as { escalation?: { reason?: string; urgency?: EscalationUrgency; message?: string } }).escalation ?? {};
							const reason = escalation.reason ?? (typeof decision.reason === 'string' ? decision.reason : 'pipeline_escalate');
							const urgency = escalation.urgency ?? self.escalationDefaultUrgency;
							const message = escalation.message ?? text.slice(0, 1000);
							let args: EscalateArgs = {
								whatsapp,
								reason,
								urgency,
								message,
								traceId: pipeCtx.traceId,
								tenantId: self.tenantId,
							};
							// v0.7: let apps augment the args (e.g. add extraColumns:
							// { patient_id }). Failures degrade to the un-transformed args
							// — never block the record path on a hook bug.
							if (self.onEscalate && ctxRef.current) {
								try {
									args = await self.onEscalate(args, ctxRef.current);
								} catch (e) {
									console.error('[Agent] onEscalate threw, using untransformed args:', e instanceof Error ? e.message : e);
								}
							}
							try {
								await self.escalationStore.record(args);
							} catch (e) {
								console.error('[Agent] escalationStore.record threw:', e instanceof Error ? e.message : e);
							}
						}
						if (decision.action !== 'reply' || !decision.reply) {
							// Policy/intent short-circuited (silent or escalate). Caller may
							// still want a deterministic shape — return what we have.
							return { answer: decision.reply?.answer ?? null, threadId: opts?.threadId ?? '' };
						}
						const { answer, threadId: newTid } = decision.reply;
						await self.session.set(whatsapp, { threadId: newTid });
						const finalAnswer = await self.enrichAnswer(answer, {
							whatsapp,
							question: text,
							wamid: inboundWamid,
							threadId: newTid,
						});
						await self.log.updateAnswer(inboundWamid, { body: text, response: finalAnswer, summary: finalAnswer });
						// v0.8: in 'assisted' mode with a reviewQueue, enqueue
						// the answer for human review INSTEAD of sending. Without
						// a reviewQueue, fall back to v0.5 behavior (send + record
						// assisted_review escalation).
						const queueing = mode === 'assisted' && self.reviewQueue !== null && !!finalAnswer;
						if (finalAnswer && mode !== 'shadow' && !queueing) await c.sendText(whatsapp, finalAnswer);
						if (queueing && self.reviewQueue && finalAnswer) {
							try {
								await self.reviewQueue.enqueue({
									whatsapp,
									aiText: finalAnswer,
									wamid: inboundWamid,
									traceId: pipeCtx.traceId,
									tenantId: self.tenantId,
									threadId: newTid,
								});
							} catch (e) {
								console.error('[Agent] reviewQueue.enqueue threw:', e instanceof Error ? e.message : e);
							}
						} else if (mode === 'assisted' && self.escalationStore) {
							await self.recordAssistedReview(whatsapp, text, pipeCtx.traceId);
						}
						return { answer: finalAnswer, threadId: newTid };
					} catch (err) {
						outcome = 'error';
						throw err;
					} finally {
						await self.emit({ type: 'agent_outcome', parentTraceId: pipeCtx.traceId, outcome });
					}
				}
				if (!self.ai) throw new Error('Agent: no AI configured');
				const { answer, threadId: newTid } = await self.ai.chat({ threadId: opts?.threadId ?? null, text });
				await self.session.set(whatsapp, { threadId: newTid });

				const enrichCtx = { whatsapp, question: text, wamid: inboundWamid, threadId: newTid };
				const enrichedAnswer = await self.enrichAnswer(answer, enrichCtx);

				let outgoing = enrichedAnswer;
				const long = !!enrichedAnswer && enrichedAnswer.length > self.summarizeOver;
				if (long && self.summarizer && enrichedAnswer) {
					const summary = await self.summarizer.summarize(enrichedAnswer);
					if (summary) outgoing = await self.enrichAnswer(summary, enrichCtx);
				}

				await self.log.updateAnswer(inboundWamid, { body: text, response: enrichedAnswer, summary: outgoing });
				// v0.8: same review-queue interception as the pipeline branch.
				const queueing = mode === 'assisted' && self.reviewQueue !== null && !!outgoing;
				if (outgoing && mode !== 'shadow' && !queueing) await c.sendText(whatsapp, outgoing);

				if (long && self.summarizer && mode !== 'shadow' && !queueing) {
					await c.sendButtons(whatsapp, {
						body: 'Want the full answer?',
						buttons: [{ id: `expand_${inboundWamid}`, title: 'Show full answer' }],
					});
				}
				if (queueing && self.reviewQueue && outgoing) {
					try {
						await self.reviewQueue.enqueue({
							whatsapp,
							aiText: outgoing,
							wamid: inboundWamid,
							tenantId: self.tenantId,
							threadId: newTid,
						});
					} catch (e) {
						console.error('[Agent] reviewQueue.enqueue threw:', e instanceof Error ? e.message : e);
					}
				} else if (mode === 'assisted' && self.escalationStore) {
					await self.recordAssistedReview(whatsapp, text, null);
				}
				return { answer: enrichedAnswer, threadId: newTid };
			},
		};
	}

	/**
	 * Record an `assisted_review` escalation per turn in `assisted` mode.
	 * Never throws — a notifier failure shouldn't break the reply path.
	 */
	private async recordAssistedReview(
		whatsapp: string,
		text: string,
		traceId: string | null,
	): Promise<void> {
		if (!this.escalationStore) return;
		try {
			await this.escalationStore.record({
				whatsapp,
				reason: 'assisted_review',
				urgency: 'low',
				message: text.slice(0, 1000),
				traceId,
				tenantId: this.tenantId,
			});
		} catch (e) {
			console.error('[Agent] assisted_review record failed:', e instanceof Error ? e.message : e);
		}
	}

	private async enrichAnswer(
		answer: string | null,
		ctx: { whatsapp: string; question: string; wamid: string; threadId: string | null | undefined },
	): Promise<string | null> {
		if (!answer || !this.replyEnricher) return answer;
		try {
			return await this.replyEnricher.enrich(answer, ctx);
		} catch (e) {
			console.error('[Agent] replyEnricher threw, using raw answer:', e instanceof Error ? e.message : e);
			return answer;
		}
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

const noOpEmit: Emit = async () => {};
