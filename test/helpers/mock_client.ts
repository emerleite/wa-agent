/**
 * MockWhatsAppClient — records every outbound call so tests can assert
 * what was sent + in what order, without hitting Meta or globalThis.fetch.
 *
 * Mirrors WhatsAppClient's surface; pass it anywhere the framework expects
 * a real client.
 */
import type { ButtonsPayload, CtaUrlPayload } from '../../src/types.js';
import type { ContactCard, TemplatePayload } from '../../src/client/whatsapp.js';

export interface RecordedCall {
	method: string;
	to: string;
	args: unknown[];
}

export class MockWhatsAppClient {
	readonly endpoint = 'https://mock.example.com/messages';
	readonly token = 'mock-token';
	readonly graphBase = 'https://mock.example.com';
	readonly authString = 'Bearer mock-token';
	readonly calls: RecordedCall[] = [];

	/** Toggle to simulate a Meta API failure. */
	failNext = false;

	private record(method: string, to: string, ...args: unknown[]): boolean {
		this.calls.push({ method, to, args });
		if (this.failNext) {
			this.failNext = false;
			return false;
		}
		return true;
	}

	async sendText(to: string, body: string, opts?: { previewUrl?: boolean }): Promise<boolean> {
		return this.record('sendText', to, body, opts);
	}
	async sendButtons(to: string, data: ButtonsPayload): Promise<boolean> {
		return this.record('sendButtons', to, data);
	}
	async sendCtaUrl(to: string, data: CtaUrlPayload): Promise<boolean> {
		return this.record('sendCtaUrl', to, data);
	}
	async sendImageUrl(to: string, data: { url: string; caption?: string }): Promise<boolean> {
		return this.record('sendImageUrl', to, data);
	}
	async sendVideoUrl(to: string, data: { url: string; caption?: string }): Promise<boolean> {
		return this.record('sendVideoUrl', to, data);
	}
	async sendAudioUrl(to: string, data: { url: string }): Promise<boolean> {
		return this.record('sendAudioUrl', to, data);
	}
	async sendContact(to: string, contact: ContactCard): Promise<boolean> {
		return this.record('sendContact', to, contact);
	}
	async sendTemplate(to: string, data: TemplatePayload): Promise<boolean> {
		return this.record('sendTemplate', to, data);
	}
	async markRead(wamid: string): Promise<boolean> {
		return this.record('markRead', wamid);
	}
	async send(): Promise<boolean> {
		return true;
	}
	async downloadMedia(): Promise<ReadableStream | null> {
		return null;
	}

	reset(): void {
		this.calls.length = 0;
		this.failNext = false;
	}

	methods(): string[] {
		return this.calls.map((c) => c.method);
	}
}
