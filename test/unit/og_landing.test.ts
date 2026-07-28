import { describe, it, expect } from 'vitest';
import { landingHtml, landingResponse } from '../../src/util/og_landing.js';

describe('landingHtml', () => {
	it('emits title, description, canonical URL', () => {
		const html = landingHtml({ title: 'Zap Prime', description: 'assistant', url: 'https://x.com' });
		expect(html).toContain('<title>Zap Prime</title>');
		expect(html).toContain('property="og:title" content="Zap Prime"');
		expect(html).toContain('property="og:description" content="assistant"');
		expect(html).toContain('property="og:url" content="https://x.com"');
	});

	it('emits meta refresh only when redirectTo is provided', () => {
		expect(landingHtml({ title: 't', description: 'd', url: 'u' })).not.toContain('http-equiv="refresh"');
		expect(landingHtml({ title: 't', description: 'd', url: 'u', redirectTo: 'https://x.com' })).toContain('http-equiv="refresh"');
	});

	it('honors custom redirectDelaySeconds', () => {
		expect(landingHtml({ title: 't', description: 'd', url: 'u', redirectTo: 'https://x.com', redirectDelaySeconds: 5 })).toContain('content="5;url=https://x.com"');
	});

	it('escapes HTML in user-supplied fields', () => {
		const html = landingHtml({ title: 't<script>alert(1)</script>', description: 'd&"', url: 'u' });
		expect(html).toContain('&lt;script&gt;');
		expect(html).not.toContain('<script>alert');
		expect(html).toContain('&amp;&quot;');
	});

	it('emits og:image + summary_large_image when image given', () => {
		const html = landingHtml({ title: 't', description: 'd', url: 'u', image: 'https://cdn/x.png' });
		expect(html).toContain('property="og:image" content="https://cdn/x.png"');
		expect(html).toContain('name="twitter:card" content="summary_large_image"');
	});

	it('defaults to summary card when no image', () => {
		expect(landingHtml({ title: 't', description: 'd', url: 'u' })).toContain('name="twitter:card" content="summary"');
	});

	it('defaults locale/lang/siteName', () => {
		const html = landingHtml({ title: 'X', description: 'd', url: 'u' });
		expect(html).toContain('lang="pt-BR"');
		expect(html).toContain('og:locale" content="pt_BR"');
		expect(html).toContain('og:site_name" content="X"');
	});
});

describe('landingResponse', () => {
	it('returns Response with text/html + cache-control', async () => {
		const r = landingResponse({ title: 't', description: 'd', url: 'u' });
		expect(r.headers.get('content-type')).toBe('text/html; charset=utf-8');
		expect(r.headers.get('cache-control')).toBe('public, max-age=3600');
		expect(await r.text()).toContain('<title>t</title>');
	});
	it('honors custom cache-control', () => {
		const r = landingResponse({ title: 't', description: 'd', url: 'u', cacheControl: 'no-store' });
		expect(r.headers.get('cache-control')).toBe('no-store');
	});
});

describe('landingHtml — mutation coverage', () => {
	it('escapes all five HTML-unsafe characters (& < > " )', () => {
		const html = landingHtml({ title: `<>&"'`, description: `<>&"'`, url: `<>&"'` });
		// Verify all five entities appear
		expect(html).toContain('&amp;');
		expect(html).toContain('&lt;');
		expect(html).toContain('&gt;');
		expect(html).toContain('&quot;');
		expect(html).toContain('&#39;');
		// And that no raw < / > / " chars leaked into the escaped fields
		const dangerous = html.match(/<>|<script/gi);
		expect(dangerous).toBeNull();
	});

	it('defaults glyph to ⚡, lang to pt-BR, locale to pt_BR, siteName to title', () => {
		const html = landingHtml({ title: 'X', description: 'd', url: 'u' });
		expect(html).toContain('⚡');
		expect(html).toContain('lang="pt-BR"');
		expect(html).toContain('og:locale" content="pt_BR"');
		expect(html).toContain('og:site_name" content="X"');
	});

	it('honors custom glyph, siteName, lang, locale', () => {
		const html = landingHtml({
			title: 'X',
			description: 'd',
			url: 'u',
			glyph: '🎯',
			siteName: 'MyApp',
			lang: 'en',
			locale: 'en_US',
		});
		expect(html).toContain('🎯');
		expect(html).not.toContain('⚡');
		expect(html).toContain('og:site_name" content="MyApp"');
		expect(html).toContain('lang="en"');
		expect(html).toContain('og:locale" content="en_US"');
	});

	it('redirectLine strips https:// and http:// prefixes when rendering the visible link', () => {
		const https = landingHtml({ title: 't', description: 'd', url: 'u', redirectTo: 'https://example.com/foo' });
		expect(https).toContain('>example.com/foo<');

		const http = landingHtml({ title: 't', description: 'd', url: 'u', redirectTo: 'http://example.com' });
		expect(http).toContain('>example.com<');
	});

	it('rejects negative redirectDelaySeconds (Math.max(0, floor)) and floors decimals', () => {
		expect(landingHtml({ title: 't', description: 'd', url: 'u', redirectTo: 'x', redirectDelaySeconds: -3 })).toContain('content="0;url=x"');
		expect(landingHtml({ title: 't', description: 'd', url: 'u', redirectTo: 'x', redirectDelaySeconds: 2.9 })).toContain('content="2;url=x"');
	});

	it('default redirectDelaySeconds is 2 when omitted', () => {
		expect(landingHtml({ title: 't', description: 'd', url: 'u', redirectTo: 'x' })).toContain('content="2;url=x"');
	});

	it('emits DOCTYPE and closes head/body/html', () => {
		const html = landingHtml({ title: 't', description: 'd', url: 'u' });
		expect(html.startsWith('<!DOCTYPE html>')).toBe(true);
		expect(html).toContain('</head>');
		expect(html).toContain('</body>');
		expect(html).toContain('</html>');
	});
});
