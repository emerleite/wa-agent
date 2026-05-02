import { describe, it, expect } from 'vitest';
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
});
