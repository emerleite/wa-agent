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
