/**
 * WhatsApp Cloud API client.
 *
 * Wraps Meta's Graph API for sending messages, marking-read, downloading media.
 * All `to` numbers are E.164 without `+` (Meta convention).
 *
 * Docs: https://developers.facebook.com/docs/whatsapp/cloud-api/reference/messages
 */
import type { ButtonsPayload, CtaUrlPayload, ReplyButton } from '../types.js';

export interface WhatsAppClientOptions {
	endpoint: string;
	token: string;
	graphBase?: string;
}

export interface ContactCard {
	name: { formatted_name: string; first_name: string };
	phones: Array<{ phone: string; type?: string; wa_id?: string }>;
	org?: { company?: string };
}

export interface TemplatePayload {
	name: string;
	language?: string;
	components?: unknown[];
}

export class WhatsAppClient {
	readonly endpoint: string;
	readonly token: string;
	readonly graphBase: string;
	readonly authString: string;

	constructor({ endpoint, token, graphBase = 'https://graph.facebook.com/v22.0' }: WhatsAppClientOptions) {
		if (!endpoint) throw new Error('WhatsAppClient: endpoint required');
		if (!token) throw new Error('WhatsAppClient: token required');
		this.endpoint = `${endpoint.replace(/\/$/, '')}/messages`;
		this.token = token;
		this.graphBase = graphBase;
		this.authString = `Bearer ${token}`;
	}

	async sendText(
		to: string,
		body: string,
		{ previewUrl = false, inReplyToWamid }: { previewUrl?: boolean; inReplyToWamid?: string | null } = {},
	): Promise<boolean> {
		const payload: Record<string, unknown> = {
			messaging_product: 'whatsapp',
			recipient_type: 'individual',
			to: normalize(to),
			type: 'text',
			text: { preview_url: previewUrl, body },
		};
		// v0.8: outbound context — when set, WhatsApp threads the reply
		// visually under the original message in the user's chat UI.
		if (inReplyToWamid) payload.context = { message_id: inReplyToWamid };
		return this.send(payload);
	}

	async sendButtons(to: string, { body, footer = null, buttons }: ButtonsPayload): Promise<boolean> {
		return this.send({
			messaging_product: 'whatsapp',
			recipient_type: 'individual',
			to: normalize(to),
			type: 'interactive',
			interactive: {
				type: 'button',
				body: { text: body },
				footer: footer ? { text: footer } : undefined,
				action: { buttons: buttons.map(toReplyButton) },
			},
		});
	}

	async sendCtaUrl(to: string, { body, displayText, url }: CtaUrlPayload): Promise<boolean> {
		return this.send({
			messaging_product: 'whatsapp',
			to: normalize(to),
			type: 'interactive',
			interactive: {
				type: 'cta_url',
				body: { text: body },
				action: { name: 'cta_url', parameters: { display_text: displayText, url } },
			},
		});
	}

	async sendImageUrl(to: string, { url, caption = '' }: { url: string; caption?: string }): Promise<boolean> {
		return this.send({
			messaging_product: 'whatsapp',
			to: normalize(to),
			type: 'image',
			image: { link: url, caption },
		});
	}

	async sendVideoUrl(to: string, { url, caption = '' }: { url: string; caption?: string }): Promise<boolean> {
		return this.send({
			messaging_product: 'whatsapp',
			to: normalize(to),
			type: 'video',
			video: { link: url, caption },
		});
	}

	async sendAudioUrl(to: string, { url }: { url: string }): Promise<boolean> {
		return this.send({
			messaging_product: 'whatsapp',
			to: normalize(to),
			type: 'audio',
			audio: { link: url },
		});
	}

	async sendContact(to: string, contact: ContactCard): Promise<boolean> {
		return this.send({
			messaging_product: 'whatsapp',
			to: normalize(to),
			type: 'contacts',
			contacts: [contact],
		});
	}

	async sendTemplate(to: string, { name, language = 'en_US', components = [] }: TemplatePayload): Promise<boolean> {
		return this.send({
			messaging_product: 'whatsapp',
			recipient_type: 'individual',
			to: normalize(to),
			type: 'template',
			template: { name, language: { code: language }, components },
		});
	}

	async markRead(wamid: string, { typing = true }: { typing?: boolean } = {}): Promise<boolean> {
		const payload: Record<string, unknown> = { messaging_product: 'whatsapp', status: 'read', message_id: wamid };
		if (typing) payload.typing_indicator = { type: 'text' };
		return this.send(payload);
	}

	async downloadMedia(mediaId: string): Promise<ReadableStream | null> {
		const meta = await fetch(`${this.graphBase}/${mediaId}`, {
			headers: { Authorization: this.authString },
		});
		if (!meta.ok) return null;
		const { url } = (await meta.json()) as { url: string };
		const file = await fetch(url, {
			headers: { Authorization: this.authString, 'User-Agent': 'wa-agent/1.0' },
		});
		return file.ok ? file.body : null;
	}

	async send(message: Record<string, unknown>): Promise<boolean> {
		const resp = await fetch(this.endpoint, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', Authorization: this.authString },
			body: JSON.stringify(message),
		});
		return resp.ok;
	}
}

function normalize(to: string): string {
	if (!to) return to;
	const s = String(to);
	return s.startsWith('+') ? s : `+${s}`;
}

function toReplyButton(b: ReplyButton | { type: 'reply'; reply: ReplyButton }): { type: 'reply'; reply: ReplyButton } {
	if ('type' in b && b.type === 'reply' && 'reply' in b) return b;
	const r = b as ReplyButton;
	return { type: 'reply', reply: { id: r.id, title: r.title } };
}
