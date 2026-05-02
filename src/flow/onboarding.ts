/**
 * Onboarding flow — first-contact composition.
 */
import type { WhatsAppClient, ContactCard } from '../client/whatsapp.js';

export interface OnboardingOptions {
	client: WhatsAppClient;
	contact?: ContactCard | null;
	welcomeBody?: string | ((args: { name: string | null }) => string);
	optInButtonId?: string;
	optInButtonTitle?: string;
	helpText?: string | ((args: { name: string | null }) => string) | null;
	delayBetweenMs?: number;
}

export class OnboardingFlow {
	readonly client: WhatsAppClient;
	readonly contact: ContactCard | null;
	readonly welcomeBody: string | ((args: { name: string | null }) => string);
	readonly optInButtonId: string;
	readonly optInButtonTitle: string;
	readonly helpText: string | ((args: { name: string | null }) => string) | null;
	readonly delayBetweenMs: number;

	constructor({
		client,
		contact = null,
		welcomeBody = 'Welcome! Tap below to start chatting.',
		optInButtonId = 'opt-in',
		optInButtonTitle = 'I agree',
		helpText = null,
		delayBetweenMs = 0,
	}: OnboardingOptions) {
		if (!client) throw new Error('OnboardingFlow: client required');
		this.client = client;
		this.contact = contact;
		this.welcomeBody = welcomeBody;
		this.optInButtonId = optInButtonId;
		this.optInButtonTitle = optInButtonTitle;
		this.helpText = helpText;
		this.delayBetweenMs = delayBetweenMs;
	}

	async greet(whatsapp: string, { name = null }: { name?: string | null } = {}): Promise<void> {
		if (this.contact) {
			await this.client.sendContact(whatsapp, this.contact);
			await this.maybeDelay();
		}

		const body = typeof this.welcomeBody === 'function' ? this.welcomeBody({ name }) : this.welcomeBody;
		await this.client.sendButtons(whatsapp, {
			body,
			buttons: [{ id: this.optInButtonId, title: this.optInButtonTitle }],
		});

		if (this.helpText) {
			await this.maybeDelay();
			const help = typeof this.helpText === 'function' ? this.helpText({ name }) : this.helpText;
			await this.client.sendText(whatsapp, help);
		}
	}

	private maybeDelay(): Promise<void> | void {
		if (this.delayBetweenMs > 0) return new Promise<void>((r) => setTimeout(r, this.delayBetweenMs));
	}
}
