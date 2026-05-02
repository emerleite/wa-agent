import { describe, it, expect, vi } from 'vitest';
import { Upsell } from '../../src/flow/upsell.js';
import { MockWhatsAppClient } from '../helpers/mock_client.js';
import type { WhatsAppClient } from '../../src/client/whatsapp.js';
import type { LeadStore } from '../../src/lead/lead_store.js';

function fakeLeads(): LeadStore & { _funnels: string[] } {
	const funnels: string[] = [];
	const leads = {
		_funnels: funnels,
		setFunnelState: vi.fn(async (_wa: string, state: string) => {
			funnels.push(state);
		}),
	};
	return leads as unknown as LeadStore & { _funnels: string[] };
}

describe('Upsell', () => {
	it('sends video → cta when video is configured', async () => {
		const client = new MockWhatsAppClient();
		const upsell = new Upsell({
			client: client as unknown as WhatsAppClient,
			pitch: 'pitch text',
			ctaText: 'Buy',
			ctaUrl: 'https://checkout.example.com',
			video: { url: 'https://media.example.com/v.mp4', caption: 'see this' },
			videoDelayMs: 0,
		});
		await upsell.send('5551');
		expect(client.methods()).toEqual(['sendVideoUrl', 'sendCtaUrl']);
	});

	it('skips video when not configured', async () => {
		const client = new MockWhatsAppClient();
		const upsell = new Upsell({
			client: client as unknown as WhatsAppClient,
			pitch: 'pitch',
			ctaText: 'Buy',
			ctaUrl: 'https://checkout.example.com',
		});
		await upsell.send('5551');
		expect(client.methods()).toEqual(['sendCtaUrl']);
	});

	it('updates funnel state when leads is configured', async () => {
		const client = new MockWhatsAppClient();
		const leads = fakeLeads();
		const upsell = new Upsell({
			client: client as unknown as WhatsAppClient,
			leads,
			pitch: 'p',
			ctaText: 'Buy',
			ctaUrl: 'https://x.com',
		});
		await upsell.send('5551');
		expect(leads._funnels).toEqual(['CHECKOUT']);
	});

	it('uses custom funnel state when configured', async () => {
		const client = new MockWhatsAppClient();
		const leads = fakeLeads();
		const upsell = new Upsell({
			client: client as unknown as WhatsAppClient,
			leads,
			funnelState: 'QUIZ',
			pitch: 'p',
			ctaText: 'Buy',
			ctaUrl: 'https://x.com',
		});
		await upsell.send('5551');
		expect(leads._funnels).toEqual(['QUIZ']);
	});

	it('does not crash if leads.setFunnelState throws', async () => {
		const client = new MockWhatsAppClient();
		const leads = {
			setFunnelState: vi.fn(async () => {
				throw new Error('lead not found');
			}),
		} as unknown as LeadStore;
		const upsell = new Upsell({
			client: client as unknown as WhatsAppClient,
			leads,
			pitch: 'p',
			ctaText: 'Buy',
			ctaUrl: 'https://x.com',
		});
		await expect(upsell.send('5551')).resolves.toBeUndefined();
		expect(client.calls.length).toBe(1); // CTA still went out
	});

	it('resolves a function-typed ctaUrl per user', async () => {
		const client = new MockWhatsAppClient();
		const upsell = new Upsell({
			client: client as unknown as WhatsAppClient,
			pitch: 'p',
			ctaText: 'Buy',
			ctaUrl: async (wa) => `https://checkout.example.com/${wa}`,
		});
		await upsell.send('5551');
		const cta = client.calls[0]?.args[0] as { url: string };
		expect(cta.url).toBe('https://checkout.example.com/5551');
	});

	it('resolves a function-typed pitch with vars', async () => {
		const client = new MockWhatsAppClient();
		const upsell = new Upsell({
			client: client as unknown as WhatsAppClient,
			pitch: ({ name }) => `Hi ${name as string}, want to subscribe?`,
			ctaText: 'Buy',
			ctaUrl: 'https://x.com',
		});
		await upsell.send('5551', { name: 'Alice' });
		const cta = client.calls[0]?.args[0] as { body: string };
		expect(cta.body).toBe('Hi Alice, want to subscribe?');
	});

	it('throws on missing required config', () => {
		const client = new MockWhatsAppClient() as unknown as WhatsAppClient;
		// @ts-expect-error missing pitch
		expect(() => new Upsell({ client, ctaText: 'x', ctaUrl: 'y' })).toThrow();
		// @ts-expect-error missing ctaText
		expect(() => new Upsell({ client, pitch: 'p', ctaUrl: 'y' })).toThrow();
	});
});

describe('Upsell.sendReminder', () => {
	function build(reminder: ConstructorParameters<typeof Upsell>[0]['reminder'] = { pitch: 'short reminder' }) {
		const client = new MockWhatsAppClient();
		return {
			client,
			upsell: new Upsell({
				client: client as unknown as WhatsAppClient,
				pitch: 'full pitch',
				ctaText: 'Subscribe',
				ctaUrl: 'https://x.com/full',
				video: { url: 'https://v.x/v.mp4' },
				videoDelayMs: 0,
				reminder,
			}),
		};
	}

	it('sends only the CTA-URL message, no video', async () => {
		const { client, upsell } = build();
		await upsell.sendReminder('5551');
		expect(client.methods()).toEqual(['sendCtaUrl']);
		const cta = client.calls[0]?.args[0] as { body: string };
		expect(cta.body).toBe('short reminder');
	});

	it('does not change funnel state', async () => {
		const setFunnel = vi.fn();
		const leads = { setFunnelState: setFunnel, get: vi.fn() } as unknown as LeadStore;
		const client = new MockWhatsAppClient();
		const upsell = new Upsell({
			client: client as unknown as WhatsAppClient,
			leads,
			pitch: 'p',
			ctaText: 'Buy',
			ctaUrl: 'https://x',
			reminder: { pitch: 'short' },
		});
		await upsell.sendReminder('5551');
		expect(setFunnel).not.toHaveBeenCalled();
	});

	it('inherits ctaText and ctaUrl from main config when reminder omits them', async () => {
		const { client, upsell } = build({ pitch: 'short' });
		await upsell.sendReminder('5551');
		const cta = client.calls[0]?.args[0] as { displayText: string; url: string };
		expect(cta.displayText).toBe('Subscribe');
		expect(cta.url).toBe('https://x.com/full');
	});

	it('honors reminder-specific ctaText and ctaUrl', async () => {
		const { client, upsell } = build({ pitch: 'short', ctaText: 'Renew', ctaUrl: 'https://x.com/short' });
		await upsell.sendReminder('5551');
		const cta = client.calls[0]?.args[0] as { displayText: string; url: string };
		expect(cta.displayText).toBe('Renew');
		expect(cta.url).toBe('https://x.com/short');
	});

	it('resolves function-typed reminder ctaUrl per user', async () => {
		const { client, upsell } = build({ pitch: 'short', ctaUrl: async (wa) => `https://x.com/u/${wa}` });
		await upsell.sendReminder('5551');
		const cta = client.calls[0]?.args[0] as { url: string };
		expect(cta.url).toBe('https://x.com/u/5551');
	});

	it('throws if no reminder was configured', async () => {
		const client = new MockWhatsAppClient();
		const upsell = new Upsell({
			client: client as unknown as WhatsAppClient,
			pitch: 'p',
			ctaText: 'Buy',
			ctaUrl: 'https://x',
		});
		await expect(upsell.sendReminder('5551')).rejects.toThrow(/reminder config/);
	});

	it('supports function-typed reminder pitch with vars', async () => {
		const client = new MockWhatsAppClient();
		const upsell = new Upsell({
			client: client as unknown as WhatsAppClient,
			pitch: 'full',
			ctaText: 'Buy',
			ctaUrl: 'https://x',
			reminder: { pitch: ({ name }) => `Hi ${name as string}, still interested?` },
		});
		await upsell.sendReminder('5551', { name: 'Alice' });
		const cta = client.calls[0]?.args[0] as { body: string };
		expect(cta.body).toBe('Hi Alice, still interested?');
	});
});

describe('Upsell.sendSmart', () => {
	function build(funnelState: string | null = null) {
		const client = new MockWhatsAppClient();
		const leads = {
			get: vi.fn(async () => (funnelState ? { funnel_state: funnelState } : null)),
			setFunnelState: vi.fn(),
		} as unknown as LeadStore;
		const upsell = new Upsell({
			client: client as unknown as WhatsAppClient,
			leads,
			funnelState: 'CHECKOUT',
			pitch: 'full pitch',
			ctaText: 'Subscribe',
			ctaUrl: 'https://x',
			video: { url: 'https://v.x/v.mp4' },
			videoDelayMs: 0,
			reminder: { pitch: 'short reminder' },
		});
		return { client, leads, upsell };
	}

	it('sends full pitch on first hit (no funnel match)', async () => {
		const { client, upsell } = build(null);
		await upsell.sendSmart('5551');
		expect(client.methods()).toEqual(['sendVideoUrl', 'sendCtaUrl']);
	});

	it('sends reminder on repeat hit (funnel already at target state)', async () => {
		const { client, upsell } = build('CHECKOUT');
		await upsell.sendSmart('5551');
		expect(client.methods()).toEqual(['sendCtaUrl']);
		const cta = client.calls[0]?.args[0] as { body: string };
		expect(cta.body).toBe('short reminder');
	});

	it('sends full pitch when lead is in a different funnel state', async () => {
		const { client, upsell } = build('NEW');
		await upsell.sendSmart('5551');
		expect(client.methods()).toEqual(['sendVideoUrl', 'sendCtaUrl']);
	});

	it('falls back to full pitch if no reminder configured', async () => {
		const client = new MockWhatsAppClient();
		const leads = { get: vi.fn(async () => ({ funnel_state: 'CHECKOUT' })), setFunnelState: vi.fn() } as unknown as LeadStore;
		const upsell = new Upsell({
			client: client as unknown as WhatsAppClient,
			leads,
			funnelState: 'CHECKOUT',
			pitch: 'p',
			ctaText: 'Buy',
			ctaUrl: 'https://x',
		});
		await upsell.sendSmart('5551');
		expect(client.methods()).toEqual(['sendCtaUrl']);
	});

	it('falls back to full pitch if leads.get throws', async () => {
		const client = new MockWhatsAppClient();
		const leads = {
			get: vi.fn(async () => { throw new Error('db down'); }),
			setFunnelState: vi.fn(),
		} as unknown as LeadStore;
		const upsell = new Upsell({
			client: client as unknown as WhatsAppClient,
			leads,
			pitch: 'p',
			ctaText: 'Buy',
			ctaUrl: 'https://x',
			reminder: { pitch: 'short' },
		});
		await upsell.sendSmart('5551');
		expect(client.methods()).toEqual(['sendCtaUrl']);
		const body = (client.calls[0]?.args[0] as { body: string }).body;
		expect(body).toBe('p'); // full pitch, not reminder
	});
});
