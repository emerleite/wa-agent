/**
 * Parse Meta WhatsApp webhook envelope into a normalized event.
 */
import type { InboundEnvelope, InboundEvent, InboundMessage } from '../types.js';

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
