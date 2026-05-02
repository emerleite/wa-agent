/**
 * wa-agent — WhatsApp Cloud API agent framework for Cloudflare Workers.
 *
 * Public surface — import named exports from this file.
 */

/// <reference path="./cloudflare.d.ts" />

export { Agent } from './agent.js';
export type { AgentOptions } from './agent.js';
export { mountWebhook } from './hono.js';

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

// Content
export { SequentialPlan } from './content/sequential_plan.js';
export type { AdvanceResult, PlanRow, DayRow, UserPlanRow } from './content/sequential_plan.js';

// Media
export { R2Cache } from './media/r2_cache.js';
export { AzureTTS, buildSSML } from './media/azure_tts.js';

// Tier gating + access control
export { TierProvider, HttpTierProvider, StaticTierProvider } from './gate/tier_provider.js';
export { AccessGate } from './gate/access_gate.js';
export type { AccessResult, AccessReason } from './gate/access_gate.js';

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
} from './dashboard/index.js';
export type { Card, CardContext } from './dashboard/index.js';

// Usage tracking
export { UsageCounter } from './usage/usage_counter.js';
export type { UsageRow, UsageCounterOptions } from './usage/usage_counter.js';

// User preferences
export { PreferenceStore, definePreference } from './preference/preference_store.js';
export type { PreferenceStoreOptions, SetOptions as PreferenceSetOptions } from './preference/preference_store.js';

// Utils
export { whatsappBold, stripMarkdown, chunkText, INTERACTIVE_BODY_MAX, TEXT_BODY_MAX } from './util/text.js';

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
