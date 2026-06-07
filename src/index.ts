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
export { createDb, isDrizzleClient } from './db/client.js';
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
export { QuietHours } from './util/quiet_hours.js';
export type { QuietHoursOptions } from './util/quiet_hours.js';
export { withUtm, createUtmTagger } from './util/utm.js';
export type { UtmParams, UtmTagger, UtmTaggerDefaults } from './util/utm.js';
export { signJwt, verifyJwt, decodeJwtUnsafe, createJwtSigner } from './util/jwt.js';
export type { JwtSigner, JwtClaims } from './util/jwt.js';

// Shared types
export type {
	Tier,
	WindowType,
	TierResult,
	InboundEvent,
	InboundMessage,
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
