/**
 * Parse Meta WhatsApp webhook envelope into a normalized event.
 */
import type { InboundEnvelope, InboundEvent, InboundMessage } from '../types.js';

/**
 * v0.15: normalized status update from Meta's webhook `statuses` array.
 * `pricingCategory` tracks Meta's classification (utility/marketing/
 * authentication/service) — right for the alarm that catches
 * UTILITY→MARKETING reclassification.
 */
export interface StatusUpdate {
	wamid: string;
	status: 'sent' | 'delivered' | 'read' | 'failed';
	pricingCategory?: 'utility' | 'marketing' | 'authentication' | 'service';
	timestampMs: number;
	recipient?: string;
	errors?: unknown[];
}

/**
 * v0.15: extract normalized status updates from a webhook envelope.
 * Complements `extractInbound` (which handles inbound messages) — Meta
 * webhooks can carry EITHER messages OR statuses in the same shape.
 * Returns `[]` when the envelope has no statuses.
 */
export function extractStatuses(envelope: InboundEnvelope | undefined | null): StatusUpdate[] {
	const out: StatusUpdate[] = [];
	const entries = envelope?.entry ?? [];
	for (const e of entries) {
		for (const c of e.changes ?? []) {
			const value = c.value as { statuses?: Array<Record<string, unknown>> } | undefined;
			for (const s of value?.statuses ?? []) {
				const rawTs = (s as { timestamp?: unknown }).timestamp;
				const timestampMs = typeof rawTs === 'string' ? parseInt(rawTs, 10) * 1000 : typeof rawTs === 'number' ? rawTs * 1000 : Date.now();
				out.push({
					wamid: String((s as { id?: unknown }).id ?? ''),
					status: (s as { status?: StatusUpdate['status'] }).status ?? 'sent',
					pricingCategory: (s as { pricing?: { category?: StatusUpdate['pricingCategory'] } }).pricing?.category,
					timestampMs,
					recipient: (s as { recipient_id?: string }).recipient_id,
					errors: (s as { errors?: unknown[] }).errors,
				});
			}
		}
	}
	return out;
}

export function extractInbound(envelope: InboundEnvelope | undefined | null): InboundEvent {
	const value = envelope?.entry?.[0]?.changes?.[0]?.value;
	if (!value) return { kind: 'unknown' };

	if (value.statuses) {
		return { kind: 'status', statuses: value.statuses };
	}

	if (!value.contacts || !value.messages) {
		return { kind: 'unknown' };
	}

	const contact = value.contacts[0];
	const m = value.messages[0];
	if (!contact || !m) return { kind: 'unknown' };

	const base: InboundMessage = {
		kind: 'message',
		wamid: m.id,
		whatsapp: contact.wa_id,
		name: contact.profile?.name ?? null,
		type: m.type,
		raw: m,
	};
	if (m.timestamp) base.timestamp = m.timestamp;
	if (m.referral?.ctwa_clid) {
		base.referral = m.referral;
		base.fromAd = true;
	}
	if (m.context?.id) base.inReplyToWamid = m.context.id;

	switch (m.type) {
		case 'text':
			base.text = m.text?.body || '';
			break;
		case 'audio':
			if (m.audio?.id) base.audioId = m.audio.id;
			break;
		case 'image':
			if (m.image?.id) base.imageId = m.image.id;
			base.caption = m.image?.caption || '';
			break;
		case 'video':
			if (m.video?.id) base.videoId = m.video.id;
			base.caption = m.video?.caption || '';
			break;
		case 'document':
			if (m.document?.id) base.documentId = m.document.id;
			if (m.document?.filename) base.filename = m.document.filename;
			break;
		case 'interactive':
			if (m.interactive?.type === 'button_reply' && m.interactive.button_reply) {
				base.subtype = 'button_reply';
				base.buttonId = m.interactive.button_reply.id;
				if (m.interactive.button_reply.title) base.buttonTitle = m.interactive.button_reply.title;
			} else if (m.interactive?.type === 'list_reply' && m.interactive.list_reply) {
				base.subtype = 'list_reply';
				base.listId = m.interactive.list_reply.id;
				if (m.interactive.list_reply.title) base.listTitle = m.interactive.list_reply.title;
			} else {
				base.subtype = 'interactive';
			}
			break;
		case 'button':
			base.subtype = 'template_button';
			if (m.button?.payload) base.buttonPayload = m.button.payload;
			if (m.button?.text) base.buttonText = m.button.text;
			break;
		case 'location':
			if (m.location) base.location = m.location;
			break;
	}

	return base;
}
