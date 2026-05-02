/**
 * Shared types used across the public surface.
 *
 * Importing the runtime types from `@cloudflare/workers-types` works when the
 * consumer has that package; we don't want a hard requirement, so we declare
 * the bits we need locally as structural interfaces. They match the shape of
 * the real bindings well enough that consumers can pass theirs unchanged.
 */

export type Json = string | number | boolean | null | { [k: string]: Json } | Json[];

// ---- Inbound webhook ----

export type Tier = 'free' | 'premium' | 'lifetime' | (string & {});
export type WindowType = 'free' | 'paid';

export interface InboundReferral {
	source_url?: string;
	source_id?: string;
	source_type?: string;
	headline?: string;
	body?: string;
	media_type?: string;
	image_url?: string;
	video_url?: string;
	thumbnail_url?: string;
	ctwa_clid?: string;
}

export interface InboundEnvelope {
	entry?: Array<{
		changes?: Array<{
			value?: {
				messages?: Array<RawMessage>;
				contacts?: Array<{ wa_id: string; profile?: { name?: string } }>;
				statuses?: Array<{ status: string }>;
			};
		}>;
	}>;
	/** Filled in by D1CoalesceQueue when multiple messages were buffered. */
	_combinedText?: string;
}

export interface RawMessage {
	id: string;
	from: string;
	timestamp?: string;
	type: string;
	text?: { body?: string };
	audio?: { id?: string };
	image?: { id?: string; caption?: string };
	video?: { id?: string; caption?: string };
	document?: { id?: string; filename?: string };
	interactive?: {
		type?: string;
		button_reply?: { id: string; title?: string };
		list_reply?: { id: string; title?: string };
	};
	button?: { payload?: string; text?: string };
	location?: { latitude: number; longitude: number };
	referral?: InboundReferral;
}

export interface InboundMessageBase {
	kind: 'message';
	wamid: string;
	whatsapp: string;
	name: string | null;
	timestamp?: string;
	raw: RawMessage;
	referral?: InboundReferral;
	fromAd?: boolean;
	/** All optional content fields below — populate only the ones that match `type`. */
	type: string;
	text?: string;
	audioId?: string;
	imageId?: string;
	videoId?: string;
	documentId?: string;
	caption?: string;
	filename?: string;
	subtype?: 'button_reply' | 'list_reply' | 'interactive' | 'template_button';
	buttonId?: string;
	buttonTitle?: string;
	listId?: string;
	listTitle?: string;
	buttonPayload?: string;
	buttonText?: string;
	location?: { latitude: number; longitude: number };
}

export type InboundMessage = InboundMessageBase;

export type InboundEvent =
	| InboundMessage
	| { kind: 'status'; statuses: Array<{ status: string }> }
	| { kind: 'unknown' };

// ---- Outbound message helpers ----

export interface ReplyButton {
	id: string;
	title: string;
}

export interface ButtonsPayload {
	body: string;
	footer?: string | null;
	buttons: Array<ReplyButton | { type: 'reply'; reply: ReplyButton }>;
}

export interface CtaUrlPayload {
	body: string;
	displayText: string;
	url: string;
}

// ---- AI ----

export interface AIChatArgs {
	threadId: string | null | undefined;
	text: string;
}
export interface AIChatResult {
	answer: string | null;
	threadId: string;
}
export interface AIClient {
	chat(args: AIChatArgs): Promise<AIChatResult>;
}

export interface SummarizerLike {
	summarize(text: string): Promise<string | null>;
}

// ---- Tier gating ----

export interface TierResult {
	authorized: boolean;
	tier: Tier;
}

// ---- Per-turn handler context ----

export interface ReplyHelper {
	text(body: string, opts?: { previewUrl?: boolean }): Promise<boolean>;
	buttons(data: ButtonsPayload): Promise<boolean>;
	cta(data: CtaUrlPayload): Promise<boolean>;
	image(data: { url: string; caption?: string }): Promise<boolean>;
	video(data: { url: string; caption?: string }): Promise<boolean>;
	audio(data: { url: string }): Promise<boolean>;
	template(data: { name: string; language?: string; components?: unknown[] }): Promise<boolean>;
	markRead(): Promise<boolean>;
	ai(text: string, opts?: { threadId?: string | null }): Promise<AIChatResult>;
}

export interface HandlerContext {
	inbound: InboundMessage;
	user: { whatsapp: string; name: string | null; lead: Record<string, unknown> | null };
	session: Record<string, unknown> | null;
	text: string;
	reply: ReplyHelper;
	db: D1Database;
	client: import('./client/whatsapp.js').WhatsAppClient;
	ai: AIClient | null;
	summarizer: SummarizerLike | null;
	window: import('./window/message_window.js').MessageWindow;
	leads: import('./lead/lead_store.js').LeadStore;
	log: import('./session/message_log.js').MessageLog;
	tier: import('./gate/tier_provider.js').TierProvider | null;
	gate: import('./gate/access_gate.js').AccessGate | null;
	isFirstContact: boolean;
	fromAd: boolean;
	[k: string]: unknown;
}

export interface ButtonContext extends HandlerContext {
	buttonId: string;
	suffix: string;
}
