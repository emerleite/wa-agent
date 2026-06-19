import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { WhatsAppClient } from '../../src/client/whatsapp.js';

const ENDPOINT = 'https://graph.facebook.com/v22.0/12345';

interface FetchCall {
	url: string;
	method: string;
	headers: Record<string, string>;
	body: unknown;
}

let calls: FetchCall[] = [];
let originalFetch: typeof fetch;

beforeEach(() => {
	calls = [];
	originalFetch = globalThis.fetch;
	globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = typeof input === 'string' ? input : input.toString();
		const body = init?.body ? JSON.parse(init.body as string) : null;
		calls.push({ url, method: init?.method || 'GET', headers: (init?.headers as Record<string, string>) || {}, body });
		return new Response(JSON.stringify({ messages: [{ id: 'wamid.X' }] }), { status: 200 });
	}) as typeof fetch;
});

afterEach(() => {
	globalThis.fetch = originalFetch;
});

describe('WhatsAppClient', () => {
	it('throws on missing endpoint or token', () => {
		expect(() => new WhatsAppClient({ endpoint: '', token: 't' })).toThrow();
		expect(() => new WhatsAppClient({ endpoint: 'x', token: '' })).toThrow();
	});

	it('appends /messages to endpoint and sets bearer auth', async () => {
		const c = new WhatsAppClient({ endpoint: ENDPOINT, token: 'T' });
		await c.sendText('5551', 'hi');
		expect(calls[0]?.url).toBe(`${ENDPOINT}/messages`);
		expect(calls[0]?.headers.Authorization).toBe('Bearer T');
	});

	it('strips trailing slash from endpoint', () => {
		const c = new WhatsAppClient({ endpoint: `${ENDPOINT}/`, token: 'T' });
		expect(c.endpoint).toBe(`${ENDPOINT}/messages`);
	});

	it('sendText normalizes phone number with leading +', async () => {
		const c = new WhatsAppClient({ endpoint: ENDPOINT, token: 'T' });
		await c.sendText('5551', 'hi');
		expect(calls[0]?.body).toMatchObject({ to: '+5551', type: 'text', text: { body: 'hi' } });
	});

	it('does not double-prefix + when already present', async () => {
		const c = new WhatsAppClient({ endpoint: ENDPOINT, token: 'T' });
		await c.sendText('+5551', 'hi');
		expect(calls[0]?.body).toMatchObject({ to: '+5551' });
	});

	it('sendButtons accepts shorthand and Meta-shaped buttons', async () => {
		const c = new WhatsAppClient({ endpoint: ENDPOINT, token: 'T' });
		await c.sendButtons('5551', {
			body: 'pick',
			buttons: [{ id: 'a', title: 'A' }, { type: 'reply', reply: { id: 'b', title: 'B' } }],
		});
		const body = calls[0]?.body as { interactive: { action: { buttons: unknown[] } } };
		expect(body.interactive.action.buttons).toEqual([
			{ type: 'reply', reply: { id: 'a', title: 'A' } },
			{ type: 'reply', reply: { id: 'b', title: 'B' } },
		]);
	});

	it('sendCtaUrl emits the right interactive payload', async () => {
		const c = new WhatsAppClient({ endpoint: ENDPOINT, token: 'T' });
		await c.sendCtaUrl('5551', { body: 'click', displayText: 'Go', url: 'https://x.com' });
		expect(calls[0]?.body).toMatchObject({
			interactive: {
				type: 'cta_url',
				body: { text: 'click' },
				action: { name: 'cta_url', parameters: { display_text: 'Go', url: 'https://x.com' } },
			},
		});
	});

	it('sendImageUrl/sendVideoUrl/sendAudioUrl produce correct types', async () => {
		const c = new WhatsAppClient({ endpoint: ENDPOINT, token: 'T' });
		await c.sendImageUrl('5551', { url: 'https://i.x/1.png', caption: 'c' });
		await c.sendVideoUrl('5551', { url: 'https://i.x/1.mp4' });
		await c.sendAudioUrl('5551', { url: 'https://i.x/1.mp3' });
		expect((calls[0]?.body as { type: string }).type).toBe('image');
		expect((calls[1]?.body as { type: string }).type).toBe('video');
		expect((calls[2]?.body as { type: string }).type).toBe('audio');
	});

	it('markRead sends the read+typing payload by default', async () => {
		const c = new WhatsAppClient({ endpoint: ENDPOINT, token: 'T' });
		await c.markRead('wamid.X');
		expect(calls[0]?.body).toMatchObject({ status: 'read', message_id: 'wamid.X', typing_indicator: { type: 'text' } });
	});

	it('markRead({typing:false}) skips the typing indicator', async () => {
		const c = new WhatsAppClient({ endpoint: ENDPOINT, token: 'T' });
		await c.markRead('wamid.X', { typing: false });
		expect((calls[0]?.body as { typing_indicator?: unknown }).typing_indicator).toBeUndefined();
	});

	it('returns false when the API returns non-2xx', async () => {
		globalThis.fetch = vi.fn(async () => new Response('err', { status: 500 })) as typeof fetch;
		const c = new WhatsAppClient({ endpoint: ENDPOINT, token: 'T' });
		expect(await c.sendText('5551', 'hi')).toBe(false);
	});

	it('sendText with inReplyToWamid adds Meta context block', async () => {
		const c = new WhatsAppClient({ endpoint: ENDPOINT, token: 'T' });
		await c.sendText('5551', 'hi', { inReplyToWamid: 'wamid.prev_42' });
		expect(calls[0]?.body).toMatchObject({
			to: '+5551',
			type: 'text',
			text: { body: 'hi' },
			context: { message_id: 'wamid.prev_42' },
		});
	});

	it('sendText without inReplyToWamid does NOT include a context block', async () => {
		const c = new WhatsAppClient({ endpoint: ENDPOINT, token: 'T' });
		await c.sendText('5551', 'hi');
		expect((calls[0]?.body as { context?: unknown }).context).toBeUndefined();
	});

	it('sendText with empty/null inReplyToWamid does NOT include a context block', async () => {
		const c = new WhatsAppClient({ endpoint: ENDPOINT, token: 'T' });
		await c.sendText('5551', 'hi', { inReplyToWamid: '' });
		expect((calls[0]?.body as { context?: unknown }).context).toBeUndefined();
		await c.sendText('5551', 'hi', { inReplyToWamid: null });
		expect((calls[1]?.body as { context?: unknown }).context).toBeUndefined();
	});

	it('sendText with both previewUrl and inReplyToWamid preserves both', async () => {
		const c = new WhatsAppClient({ endpoint: ENDPOINT, token: 'T' });
		await c.sendText('5551', 'hi http://x', { previewUrl: true, inReplyToWamid: 'wamid.X' });
		expect(calls[0]?.body).toMatchObject({
			text: { preview_url: true, body: 'hi http://x' },
			context: { message_id: 'wamid.X' },
		});
	});
});
