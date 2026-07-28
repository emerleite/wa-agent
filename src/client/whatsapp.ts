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

export interface AuthenticationTemplateOptions {
	name: string;
	language?: string;
	/** Zero-based index of the URL button that carries the code. Default 0. */
	buttonIndex?: number;
}

export class WhatsAppClient {
	readonly endpoint: string;
	readonly token: string;
	readonly graphBase: string;
	readonly authString: string;

	constructor({ endpoint, token, graphBase = 'https://graph.facebook.com/v22.0' }: WhatsAppClientOptions) { // hardcoded:allow — framework-level Meta API default
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

	/**
	 * v0.16: send a Meta AUTHENTICATION-category template (the "your code is
	 * XXXXXX" flow). Encodes the non-obvious Meta rule that the OTP code
	 * MUST appear in BOTH the body parameter AND the URL button parameter —
	 * miss one and the "Copy code" button doesn't populate correctly.
	 *
	 * The template itself must be pre-approved by Meta in the
	 * AUTHENTICATION category with a body {{1}} placeholder + a copy-code
	 * URL button. See `docs/META_SETUP.md` for the template shape.
	 *
	 *   await client.sendAuthenticationTemplate('5511999999999', '482913', {
	 *     name: 'portal_otp',
	 *     language: 'pt_BR',
	 *   });
	 *
	 * Pairs with v0.13's `generateOtpCode` + `hashOtpCode` for a full
	 * portal-OTP flow.
	 */
	async sendAuthenticationTemplate(to: string, code: string, opts: AuthenticationTemplateOptions): Promise<boolean> {
		if (!opts.name) throw new Error('sendAuthenticationTemplate: template name required');
		if (!code) throw new Error('sendAuthenticationTemplate: code required');
		const language = opts.language ?? 'pt_BR';
		const buttonIndex = String(opts.buttonIndex ?? 0);
		return this.send({
			messaging_product: 'whatsapp',
			to: normalize(to),
			type: 'template',
			template: {
				name: opts.name,
				language: { code: language },
				components: [
					{ type: 'body', parameters: [{ type: 'text', text: code }] },
					{
						type: 'button',
						sub_type: 'url',
						index: buttonIndex,
						parameters: [{ type: 'text', text: code }],
					},
				],
			},
		});
	}

	async downloadMedia(mediaId: string): Promise<ReadableStream | null> {
		const r = await this.downloadMediaWithMeta(mediaId);
		return r?.stream ?? null;
	}

	/**
	 * v0.15: download variant that also returns the metadata Meta hands out
	 * (mime_type, sha256, file_size). Right for pipelines that put the bytes
	 * into R2 with the correct `contentType` instead of guessing.
	 */
	async downloadMediaWithMeta(mediaId: string): Promise<{
		stream: ReadableStream;
		mimeType?: string;
		sha256?: string;
		fileSize?: number;
	} | null> {
		const meta = await fetch(`${this.graphBase}/${mediaId}`, {
			headers: { Authorization: this.authString },
		});
		if (!meta.ok) return null;
		const info = (await meta.json()) as {
			url: string;
			mime_type?: string;
			sha256?: string;
			file_size?: number;
		};
		if (!info?.url) return null;
		const file = await fetch(info.url, {
			headers: { Authorization: this.authString, 'User-Agent': 'wa-agent/1.0' }, // hardcoded:allow — framework identity
		});
		if (!file.ok || !file.body) return null;
		return {
			stream: file.body,
			mimeType: info.mime_type,
			sha256: info.sha256,
			fileSize: info.file_size,
		};
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
