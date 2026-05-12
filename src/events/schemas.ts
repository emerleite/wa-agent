/**
 * Framework-generic event schemas.
 *
 * These are emitted automatically by the Agent + built-in stores. Bots can
 * compose their own event schemas alongside (see README) — they all flow into
 * the same Analytics Engine dataset.
 *
 * Wall: keep these payloads *minimal* and *non-PII*. No message bodies, no
 * answer text. Just metadata, identifiers, latency, status.
 */
import { z } from 'zod';
import { BaseEventFields } from './base.js';

export const MessageInboundEvent = z.object({
	...BaseEventFields,
	type: z.literal('message_inbound'),
	whatsapp: z.string(),
	wamid: z.string(),
	messageType: z.enum(['text', 'audio', 'image', 'button_reply', 'list_reply', 'template_button', 'document', 'interactive']),
	isFirstContact: z.boolean(),
	fromAd: z.boolean(),
});

export const OptInEvent = z.object({
	...BaseEventFields,
	type: z.literal('opt_in'),
	whatsapp: z.string(),
});

export const OptOutEvent = z.object({
	...BaseEventFields,
	type: z.literal('opt_out'),
	whatsapp: z.string(),
});

export const GateBlockedEvent = z.object({
	...BaseEventFields,
	type: z.literal('gate_blocked'),
	whatsapp: z.string(),
	tier: z.string(),
	reason: z.enum(['tier', 'trial', 'denied']),
});

export const BroadcastSentEvent = z.object({
	...BaseEventFields,
	type: z.literal('broadcast_sent'),
	whatsapp: z.string(),
	channel: z.string(),
});

export const PlanDayDeliveredEvent = z.object({
	...BaseEventFields,
	type: z.literal('plan_day_delivered'),
	whatsapp: z.string(),
	planId: z.number().int(),
	day: z.number().int(),
});

export const AgentDecisionEvent = z.object({
	...BaseEventFields,
	type: z.literal('agent_decision'),
	whatsapp: z.string(),
	intent: z.string(),
	action: z.enum(['reply', 'escalate', 'silent']),
	latencyMs: z.number().int().nonnegative(),
	model: z.string().nullable(),
});

export const AgentOutcomeEvent = z.object({
	...BaseEventFields,
	type: z.literal('agent_outcome'),
	parentTraceId: z.string().uuid(),
	outcome: z.enum(['ok', 'error', 'timeout', 'no_response']),
});

export const ErrorEvent = z.object({
	...BaseEventFields,
	type: z.literal('error'),
	whatsapp: z.string().optional(),
	source: z.string(),
	message: z.string(),
});

export const FrameworkEventSchema = z.discriminatedUnion('type', [
	MessageInboundEvent,
	OptInEvent,
	OptOutEvent,
	GateBlockedEvent,
	BroadcastSentEvent,
	PlanDayDeliveredEvent,
	AgentDecisionEvent,
	AgentOutcomeEvent,
	ErrorEvent,
]);

export type FrameworkEvent = z.infer<typeof FrameworkEventSchema>;
export type FrameworkEventType = FrameworkEvent['type'];

/** Input shape — `v`, `ts`, `traceId` are stamped by `emit()`. */
export type FrameworkEventInput = {
	[T in FrameworkEventType]: Omit<Extract<FrameworkEvent, { type: T }>, 'v' | 'ts' | 'traceId'> & {
		traceId?: string;
	};
}[FrameworkEventType];
