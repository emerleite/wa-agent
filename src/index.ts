/**
 * wa-agent — WhatsApp Cloud API agent framework for Cloudflare Workers.
 *
 * Public surface — import named exports from this file.
 */

/// <reference path="./cloudflare.d.ts" />

export { Agent } from './agent.js';
export type { AgentOptions } from './agent.js';
export { mountWebhook } from './hono.js';

// Drizzle DB layer (v0.2+)
export { createDb, isDrizzleClient, normalizeDb } from './db/client.js';
export type { DB, Schema } from './db/client.js';
export * as schema from './db/schema/index.js';

// Client + webhook
export { WhatsAppClient } from './client/whatsapp.js';
export type { WhatsAppClientOptions, ContactCard, TemplatePayload } from './client/whatsapp.js';
export { extractInbound } from './webhook/extract.js';
export { verifyMetaSignature, handleVerifyChallenge } from './webhook/verify.js';

// Stores
export { D1CoalesceQueue, combineText } from './queue/d1_coalesce_queue.js';
export type { BatchInfo, BatchHandler, QueueRow, D1QueueOptions } from './queue/d1_coalesce_queue.js';
export { SessionStore } from './session/session_store.js';
export { MessageLog } from './session/message_log.js';
export { LeadStore } from './lead/lead_store.js';
export { MessageWindow } from './window/message_window.js';

// AI
export { OpenAIAssistant, defaultClean } from './ai/openai_assistant.js';
export { Summarizer } from './ai/summarizer.js';
export { Transcriber } from './ai/transcriber.js';
export { LayeredReplyEnricher, asEnricher } from './ai/reply_enricher.js';
export type { ReplyEnricher, ReplyEnricherFn, ReplyEnrichContext, LayeredReplyEnricherOptions } from './ai/reply_enricher.js';
export { HeuristicFallbackClassifier, heuristicFallback } from './ai/heuristic_fallback_classifier.js';
export type { HeuristicFallbackClassifierOptions, HeuristicFn } from './ai/heuristic_fallback_classifier.js';

// Routers
export { CommandRouter } from './router/command_router.js';
export type { CommandHandler } from './router/command_router.js';
export { ButtonRouter } from './router/button_router.js';
export type { ButtonHandler } from './router/button_router.js';

// Schedulers
export { Broadcast } from './scheduler/broadcast.js';
export type { BroadcastResult } from './scheduler/broadcast.js';
export { ReEngagement } from './scheduler/reengagement.js';
export { SlotDelivery, weightedPick } from './scheduler/slot_delivery.js';
export { RateCappedDispatcher } from './scheduler/rate_capped_dispatcher.js';
export { BotSendPacing, DEFAULT_PACING_COLUMNS } from './scheduler/bot_send_pacing.js';
export type {
	BotSendPacingOptions,
	PacingField,
	CanSendOptions,
	RecordSentOptions,
	BotSendRow,
} from './scheduler/bot_send_pacing.js';
export type { BotSendLogRow } from './db/schema/bot_send_log.js';
export type {
	RateCappedDispatcherOptions,
	DispatchResult,
	DispatchReason,
	SendFn,
} from './scheduler/rate_capped_dispatcher.js';

// Content
export { SequentialPlan } from './content/sequential_plan.js';
export type { AdvanceResult, PlanRow, DayRow, UserPlanRow } from './content/sequential_plan.js';
export { ContentGenerator } from './content/content_generator.js';
export type {
	ContentGeneratorOptions,
	EnsureResult as ContentEnsureResult,
	EnsureStatus as ContentEnsureStatus,
} from './content/content_generator.js';

// Media
export { R2Cache } from './media/r2_cache.js';
export { AzureTTS, buildSSML } from './media/azure_tts.js';
export { ButtonImageDispatcher } from './media/button_image_dispatcher.js';
export type {
	ButtonImageDispatcherOptions,
	DispatchImageResult,
	DispatchImageReason,
} from './media/button_image_dispatcher.js';

// Tier gating + access control
export { TierProvider, HttpTierProvider, StaticTierProvider } from './gate/tier_provider.js';
export { AccessGate } from './gate/access_gate.js';
export type { AccessResult, AccessReason } from './gate/access_gate.js';
export { PaymentLinkProvider, HttpPaymentLinkProvider, expandTokens } from './gate/payment_link_provider.js';
export type {
	HttpPaymentLinkProviderOptions,
	PaymentLinkContext,
	TokenResolver,
} from './gate/payment_link_provider.js';

// Composed flows
export { OnboardingFlow } from './flow/onboarding.js';
export { Upsell } from './flow/upsell.js';

// Search
export { HybridSearch, buildSearchSchema } from './search/hybrid_search.js';

// Dashboard
export {
	Dashboard,
	defaultCards,
	summaryCard,
	queueCard,
	funnelCard,
	messagesChartCard,
	dauCard,
	engagementCard,
	plansCard,
	churnCard,
	gateConversionCard,
} from './dashboard/index.js';
export type { Card, CardContext } from './dashboard/index.js';

// Usage tracking
export { UsageCounter } from './usage/usage_counter.js';
export type { UsageCounterOptions } from './usage/usage_counter.js';
export type { FeatureUsageRow } from './db/schema/usage.js';
export { LLMCostCalculator, computeLLMCost, DEFAULT_PRICE_TABLE } from './usage/llm_cost.js';
export type { LLMCostArgs, LLMCostResult, LLMCostCalculatorOptions, LLMUsage, ModelPrice, PriceTable } from './usage/llm_cost.js';

// User preferences
export { PreferenceStore, definePreference } from './preference/preference_store.js';
export type { PreferenceStoreOptions, SetOptions as PreferenceSetOptions } from './preference/preference_store.js';

// Per-channel opt-out
export { ChannelOptOuts } from './channel/channel_opt_outs.js';
export type { ChannelOptOutsOptions } from './channel/channel_opt_outs.js';
export type { ChannelOptOutRow } from './db/schema/channel_opt_outs.js';

// Admin auth (dual Bearer / Basic guard for /admin/* endpoints)
export { requireAdminAuth, timingSafeStringEqual } from './security/admin_auth.js';
export type { AdminAuthConfig } from './security/admin_auth.js';

// Crypto primitives (OTP + session token generation, SHA-256, salted hashes)
export {
	generateOtpCode,
	generateRandomToken,
	sha256Hex,
	hashOtpCode,
	hashSessionToken,
} from './security/crypto.js';

// Cookie helpers (session cookie serialization + parsing)
export { serializeCookie, clearCookie, parseCookieHeader, getCookie } from './security/cookie.js';
export type { CookieOptions } from './security/cookie.js';

// Abuse blocklist (hot-path check at webhook boundary)
export { Blocklist } from './security/blocklist.js';
export type { BlocklistOptions, BlockArgs, ListBlockedOptions } from './security/blocklist.js';
export type { BlockedNumberRow } from './db/schema/blocklist.js';

// Sliding-window rate limit (KV-backed; webhook protection)
export {
	RateLimit,
	KvRateLimitStore,
	MemoryRateLimitStore,
	honoRateLimit,
} from './security/rate_limit.js';
export type {
	RateLimitStore,
	RateLimitResult,
	RateLimitOptions,
	KvRateLimitStoreOptions,
	HonoRateLimitOptions,
	HonoRateLimitContext,
} from './security/rate_limit.js';

// Escalation log + pluggable notifier
export {
	EscalationStore,
	NoOpNotifier,
	HttpNotifier,
	SlackNotifier,
} from './escalate/escalation_store.js';
export type {
	EscalationNotifier,
	EscalationStoreOptions,
	EscalateArgs,
	ResolveArgs as EscalationResolveArgs,
	ListEscalationsOptions,
	EscalationUrgency,
	EscalationReason,
	HttpNotifierOptions,
	SlackNotifierOptions,
} from './escalate/escalation_store.js';
export type { EscalationRow } from './db/schema/escalations.js';
export { DEFAULT_ESCALATION_COLUMNS } from './escalate/escalation_store.js';
export type { EscalationField } from './escalate/escalation_store.js';

// Multi-tenant routing
export { MultiTenantAgentRegistry, MemoryAgentCache, mountMultiTenantWebhook } from './multi_tenant/registry.js';
export type {
	MultiTenantAgentRegistryOptions,
	AgentCache,
	MountMultiTenantWebhookOptions,
} from './multi_tenant/registry.js';

// User consent tracking + pipeline gate
export { ConsentStore, consentGate, DEFAULT_CONSENT_COLUMNS } from './consent/consent_store.js';
export type {
	ConsentStoreOptions,
	ConsentField,
	ConsentRow,
	ConsentGateOptions,
	ConsentGateAction,
	GrantOptions as ConsentGrantOptions,
	ConsentLookupOptions,
	ConsentWhereExtra,
} from './consent/consent_store.js';

// AI provider layer (v0.9) — multi-provider routing with circuit breaker + ledger
export { CircuitBreaker } from './ai/circuit_breaker.js';
export type {
	CircuitState,
	CircuitErrorKind,
	CircuitBucketConfig,
	CircuitBreakerConfig,
	CircuitMetrics,
} from './ai/circuit_breaker.js';
export { OpenAICompatProvider, WorkersAIProvider } from './ai/llm_provider.js';
export type {
	LLMProvider,
	ProviderRunArgs,
	ProviderResult,
	ProviderSuccess,
	ProviderFailure,
	ProviderErrorKind,
	OpenAICompatProviderOptions,
	WorkersAIProviderOptions,
	WorkersAIBinding,
} from './ai/llm_provider.js';
export { AICallLedger, DEFAULT_CALL_LOG_COLUMNS } from './ai/ai_call_log.js';
export type {
	AICallLedgerOptions,
	CallField,
	CallStatus,
	CallRow,
	RecordCallArgs,
	ListCallsOptions,
} from './ai/ai_call_log.js';
export type { AICallLogRow } from './db/schema/ai_call_log.js';
export { AIRouter, envChainResolver } from './ai/router.js';
export type {
	AIRouterOptions,
	RouteArgs,
	RouteResult,
	RouteSuccess,
	RouteFailure,
	ChainAttempt,
} from './ai/router.js';

// Agent loop (v0.11) — multi-step tool-calling on top of AgentLLM adapters.
// Ships with a Vercel AI SDK adapter at `wa-agent/ai-sdk` (subpath export).
// See docs/AGENT_LOOP.md for setup, tool authoring, and observability.
export { AgentLoop } from './agent_loop/loop.js';
export type {
	AgentLoopOptions,
	RunArgs as AgentLoopRunArgs,
} from './agent_loop/loop.js';
export { ToolRegistry } from './agent_loop/tool_registry.js';
export type { ToolExecuteResult } from './agent_loop/tool_registry.js';
export { ConversationMemory, DEFAULT_MEMORY_COLUMNS } from './agent_loop/conversation_memory.js';
export type {
	ConversationMemoryOptions,
	MemoryField,
	AppendRowInput,
	LoadWindowOptions,
} from './agent_loop/conversation_memory.js';
export type {
	AgentMessage,
	ToolCall,
	AgentTool,
	AgentStep,
	AgentRunResult,
	AgentLLM,
	AgentLLMArgs,
	AgentLLMResult,
	AgentToolDescriptor,
} from './agent_loop/types.js';
export type { AgentTurnRow } from './db/schema/agent_turns.js';

// Human-review queue (v0.8 — closes the assisted-mode loop)
export { AgentReviewQueue, DEFAULT_REVIEW_COLUMNS } from './review/review_queue.js';
export type {
	AgentReviewQueueOptions,
	ReviewField,
	ReviewRow,
	ReviewStatus,
	EnqueueReviewArgs,
	ApproveReviewArgs,
	ListReviewsOptions,
} from './review/review_queue.js';
export type { PendingReviewRow } from './db/schema/pending_reviews.js';

// Account linking — short-lived web-issued codes → identity ⇄ whatsapp mapping
export { AccountLinkStore, matchLinkCommand } from './link/account_link_store.js';
export type {
	AccountLinkStoreOptions,
	IssueCodeArgs,
	RedeemReason,
	RedeemResult,
} from './link/account_link_store.js';
export type { AccountLinkRow, AccountLinkCodeRow } from './db/schema/account_links.js';

// Agent pipeline (v0.2+) — intent → policy → LLM → audit
export { AgentPipeline, LLMIntentClassifier, PolicyGate, LLMResponder, AuditEmitter, defaultPipeline, emptyDecision } from './pipeline/index.js';
export type {
	PipelineAction,
	PipelineContext,
	PipelineDecision,
	PipelineStep,
	StepResult,
	IntentResult,
	IntentClassifyFn,
	LLMIntentClassifierOptions,
	PolicyVerdict,
	PolicyPredicate,
	PolicyGateOptions,
	LLMResponderOptions,
	AuditEmitterOptions,
	DefaultPipelineOptions,
} from './pipeline/index.js';

// Events (v0.2+) — Zod-validated event stream + Analytics Engine sink
export {
	makeEmit,
	FrameworkEventSchema,
	MessageInboundEvent,
	OptInEvent,
	OptOutEvent,
	GateBlockedEvent,
	BroadcastSentEvent,
	PlanDayDeliveredEvent,
	AgentDecisionEvent,
	AgentOutcomeEvent,
	ErrorEvent,
	BaseEventFields,
	stampBase,
} from './events/index.js';
export type { Emit, EventsBindings, EmitOptions, FrameworkEvent, FrameworkEventType, FrameworkEventInput, EventInputBase } from './events/index.js';

// Utils
export { whatsappBold, stripMarkdown, chunkText, INTERACTIVE_BODY_MAX, TEXT_BODY_MAX } from './util/text.js';
export { formatForWhatsapp } from './util/whatsapp_format.js';
export { QuietHours } from './util/quiet_hours.js';
export type { QuietHoursOptions } from './util/quiet_hours.js';
export { withUtm, createUtmTagger } from './util/utm.js';
export type { UtmParams, UtmTagger, UtmTaggerDefaults } from './util/utm.js';
export { signJwt, verifyJwt, decodeJwtUnsafe, createJwtSigner } from './util/jwt.js';
export type { JwtSigner, JwtClaims } from './util/jwt.js';
export { normalizeIdentifier } from './util/normalize_identifier.js';
export type { NormalizeIdentifierOptions } from './util/normalize_identifier.js';
export { computeHoldout } from './util/holdout.js';
export type { ComputeHoldoutArgs } from './util/holdout.js';
export { digits, normalizeBrazilianPhone, localizeBrazilianPhone, formatBrazilianPhone } from './util/phone_br.js';
export { extractFirstJsonObject, tryExtractFirstJsonObject } from './util/llm_json.js';
export { log } from './util/log.js';
export type { Log } from './util/log.js';
export { formatStateBlock } from './util/state_block.js';
export type { StateBlockOptions } from './util/state_block.js';

// Observability — tracer interface + Langfuse impl (optional; NoOp default)
export { NoOpTracer, LangfuseTracer } from './observability/tracer.js';
export type { Tracer, TraceEvent, LangfuseTracerOptions } from './observability/tracer.js';

// Media stores
export { R2MediaStore } from './media/r2_media_store.js';
export type { R2MediaStoreOptions, UploadArgs as R2MediaUploadArgs, UploadResult as R2MediaUploadResult } from './media/r2_media_store.js';

// Shared types
export type {
	Tier,
	WindowType,
	AgentMode,
	TierResult,
	InboundEnvelope,
	InboundEvent,
	InboundMessage,
	RawMessage,
	InboundReferral,
	HandlerContext,
	ButtonContext,
	ReplyHelper,
	AIClient,
	AIChatArgs,
	AIChatResult,
	SummarizerLike,
	ButtonsPayload,
	CtaUrlPayload,
	ReplyButton,
} from './types.js';
