import { describe, it, expect } from 'vitest';
import { OnboardingFlow } from '../../src/flow/onboarding.js';
import { MockWhatsAppClient } from '../helpers/mock_client.js';
import type { WhatsAppClient } from '../../src/client/whatsapp.js';

const CONTACT = {
	name: { formatted_name: 'Bot', first_name: 'Bot' },
	phones: [{ phone: '+15551234567', type: 'Main', wa_id: '15551234567' }],
};

describe('OnboardingFlow', () => {
	it('sends contact → buttons → help in that order', async () => {
		const client = new MockWhatsAppClient();
		const flow = new OnboardingFlow({
			client: client as unknown as WhatsAppClient,
			contact: CONTACT,
			welcomeBody: 'Welcome!',
			helpText: 'Type help any time.',
		});
		await flow.greet('5551');
		expect(client.methods()).toEqual(['sendContact', 'sendButtons', 'sendText']);
	});

	it('skips the contact card when not configured', async () => {
		const client = new MockWhatsAppClient();
		const flow = new OnboardingFlow({ client: client as unknown as WhatsAppClient, welcomeBody: 'Hi' });
		await flow.greet('5551');
		expect(client.methods()).toEqual(['sendButtons']);
	});

	it('skips the help message when not configured', async () => {
		const client = new MockWhatsAppClient();
		const flow = new OnboardingFlow({ client: client as unknown as WhatsAppClient, contact: CONTACT, welcomeBody: 'Hi' });
		await flow.greet('5551');
		expect(client.methods()).toEqual(['sendContact', 'sendButtons']);
	});

	it('passes user name to function-typed welcome body', async () => {
		const client = new MockWhatsAppClient();
		const flow = new OnboardingFlow({
			client: client as unknown as WhatsAppClient,
			welcomeBody: ({ name }) => `Hi ${name ?? 'there'}!`,
		});
		await flow.greet('5551', { name: 'Alice' });
		const buttonCall = client.calls[0];
		expect(buttonCall?.method).toBe('sendButtons');
		const data = buttonCall?.args[0] as { body: string };
		expect(data.body).toBe('Hi Alice!');
	});

	it('uses fallback when no name is provided', async () => {
		const client = new MockWhatsAppClient();
		const flow = new OnboardingFlow({
			client: client as unknown as WhatsAppClient,
			welcomeBody: ({ name }) => `Hi ${name ?? 'there'}!`,
		});
		await flow.greet('5551');
		const data = client.calls[0]?.args[0] as { body: string };
		expect(data.body).toBe('Hi there!');
	});

	it('uses configured opt-in button id and title', async () => {
		const client = new MockWhatsAppClient();
		const flow = new OnboardingFlow({
			client: client as unknown as WhatsAppClient,
			welcomeBody: 'Hi',
			optInButtonId: 'subscribe',
			optInButtonTitle: 'Sign me up',
		});
		await flow.greet('5551');
		const data = client.calls[0]?.args[0] as { buttons: Array<{ id: string; title: string }> };
		expect(data.buttons[0]).toEqual({ id: 'subscribe', title: 'Sign me up' });
	});

	it('all messages target the same user', async () => {
		const client = new MockWhatsAppClient();
		const flow = new OnboardingFlow({
			client: client as unknown as WhatsAppClient,
			contact: CONTACT,
			welcomeBody: 'Hi',
			helpText: 'Help text',
		});
		await flow.greet('5551');
		for (const call of client.calls) {
			expect(call.to).toBe('5551');
		}
	});
});
