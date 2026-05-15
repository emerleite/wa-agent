import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { buildSSML, AzureTTS } from '../../src/media/azure_tts.js';

describe('buildSSML', () => {
	it('wraps text with voice + prosody envelopes', () => {
		const ssml = buildSSML('hello', { voice: 'en-US-A', rate: '-5%', pitch: '0%', language: 'en-US' });
		expect(ssml).toContain('xml:lang="en-US"');
		expect(ssml).toContain('<voice name="en-US-A">');
		expect(ssml).toContain('<prosody rate="-5%" pitch="0%">hello</prosody>');
	});

	it('escapes XML-special characters', () => {
		const ssml = buildSSML(`<say>"hi & bye"</say>`, { voice: 'v', rate: '0%', pitch: '0%', language: 'en-US' });
		expect(ssml).toContain('&lt;say&gt;');
		expect(ssml).toContain('&quot;');
		expect(ssml).toContain('&amp;');
	});

	it('escapes single quotes', () => {
		const ssml = buildSSML("it's fine", { voice: 'v', rate: '0%', pitch: '0%', language: 'en-US' });
		expect(ssml).toContain('&apos;');
	});

	it('escapes & before > so &gt; is not double-escaped', () => {
		const ssml = buildSSML('a > b & c', { voice: 'v', rate: '0%', pitch: '0%', language: 'en-US' });
		expect(ssml).toContain('a &gt; b &amp; c');
		expect(ssml).not.toContain('&amp;gt;');
	});

	it('embeds the provided language in xml:lang', () => {
		const ssml = buildSSML('hi', { voice: 'v', rate: '0%', pitch: '0%', language: 'pt-BR' });
		expect(ssml).toContain('xml:lang="pt-BR"');
	});
});

describe('AzureTTS', () => {
	it('throws on missing key or region', () => {
		expect(() => new AzureTTS({ key: '', region: 'r' })).toThrow();
		expect(() => new AzureTTS({ key: 'k', region: '' })).toThrow();
	});

	it('uses default voice/rate/pitch/language when not provided', () => {
		const t = new AzureTTS({ key: 'k', region: 'r' });
		// Defaults are private but observable via SSML
		// Just ensure constructor doesn't throw and instance exists.
		expect(t).toBeDefined();
	});

	describe('synthesize', () => {
		let originalFetch: typeof fetch;
		beforeEach(() => {
			originalFetch = globalThis.fetch;
		});
		afterEach(() => {
			globalThis.fetch = originalFetch;
		});

		it('POSTs to the regional TTS endpoint with the subscription key', async () => {
			const fetchMock = vi.fn(async () => new Response(new ArrayBuffer(8), { status: 200 }));
			globalThis.fetch = fetchMock as typeof fetch;
			const t = new AzureTTS({ key: 'subkey', region: 'eastus' });
			const buf = await t.synthesize('hello');
			expect(buf.byteLength).toBe(8);
			const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
			expect(url).toBe('https://eastus.tts.speech.microsoft.com/cognitiveservices/v1');
			expect(init.method).toBe('POST');
			const headers = init.headers as Record<string, string>;
			expect(headers['Ocp-Apim-Subscription-Key']).toBe('subkey');
			expect(headers['Content-Type']).toBe('application/ssml+xml');
			expect(headers['X-Microsoft-OutputFormat']).toBe('audio-24khz-48kbitrate-mono-mp3');
		});

		it('sends SSML built from the configured voice/rate/pitch/language', async () => {
			const fetchMock = vi.fn(async () => new Response(new ArrayBuffer(2), { status: 200 }));
			globalThis.fetch = fetchMock as typeof fetch;
			const t = new AzureTTS({
				key: 'k',
				region: 'r',
				voice: 'pt-BR-FranciscaNeural',
				rate: '-10%',
				pitch: '+5%',
				language: 'pt-BR',
			});
			await t.synthesize('olá');
			const calls = fetchMock.mock.calls as unknown as Array<[string, RequestInit]>;
			const init = calls[0]?.[1] as RequestInit;
			const body = String(init.body);
			expect(body).toContain('xml:lang="pt-BR"');
			expect(body).toContain('<voice name="pt-BR-FranciscaNeural">');
			expect(body).toContain('rate="-10%"');
			expect(body).toContain('pitch="+5%"');
			expect(body).toContain('olá');
		});

		it('uses defaults in the SSML when no overrides are passed', async () => {
			const fetchMock = vi.fn(async () => new Response(new ArrayBuffer(2), { status: 200 }));
			globalThis.fetch = fetchMock as typeof fetch;
			const t = new AzureTTS({ key: 'k', region: 'r' });
			await t.synthesize('hi');
			const calls = fetchMock.mock.calls as unknown as Array<[string, RequestInit]>;
			const init = calls[0]?.[1] as RequestInit;
			const body = String(init.body);
			expect(body).toContain('xml:lang="en-US"');
			expect(body).toContain('<voice name="en-US-AriaNeural">');
			expect(body).toContain('rate="0%"');
			expect(body).toContain('pitch="0%"');
		});

		it('throws on non-ok response with status + truncated body', async () => {
			const longBody = 'X'.repeat(500);
			globalThis.fetch = vi.fn(async () => new Response(longBody, { status: 429 })) as typeof fetch;
			const t = new AzureTTS({ key: 'k', region: 'r' });
			await expect(t.synthesize('hi')).rejects.toThrow(/AzureTTS 429/);
			await expect(t.synthesize('hi')).rejects.toThrow(/X{200}/);
		});

		it('truncates very long error bodies to ~200 chars', async () => {
			const longBody = 'A'.repeat(1000);
			globalThis.fetch = vi.fn(async () => new Response(longBody, { status: 500 })) as typeof fetch;
			const t = new AzureTTS({ key: 'k', region: 'r' });
			try {
				await t.synthesize('hi');
				expect.fail('expected throw');
			} catch (e) {
				const msg = e instanceof Error ? e.message : String(e);
				// Status prefix is "AzureTTS 500: " (14 chars); then ~200 chars of body
				expect(msg.length).toBeLessThan(300);
			}
		});
	});
});
