import { describe, it, expect } from 'vitest';
import { Dashboard, summaryCard, queueCard, funnelCard, messagesChartCard, defaultCards } from '../../src/dashboard/index.js';

describe('Dashboard.renderShell', () => {
	it('renders the page title', () => {
		const d = new Dashboard({ title: 'My Bot', cards: [] });
		const html = d.renderShell('/dashboard');
		expect(html).toContain('<title>My Bot</title>');
		expect(html).toContain('<h1>My Bot</h1>');
	});

	it('escapes HTML in the title', () => {
		const d = new Dashboard({ title: '<script>alert(1)</script>', cards: [] });
		const html = d.renderShell('/dashboard');
		expect(html).not.toContain('<script>alert(1)</script>');
		expect(html).toContain('&lt;script&gt;');
	});

	it('emits one HTMX-bound div per card', () => {
		const d = new Dashboard({
			title: 'X',
			cards: [
				{ id: 'a', refreshSeconds: 10, render: () => '' },
				{ id: 'b', render: () => '' },
			],
		});
		const html = d.renderShell('/dashboard');
		expect(html).toContain('hx-get="/dashboard/c/a"');
		expect(html).toContain('hx-trigger="load, every 10s"');
		expect(html).toContain('hx-get="/dashboard/c/b"');
		expect(html).toContain('hx-trigger="load"');
	});

	it('loads HTMX + Chart.js', () => {
		const d = new Dashboard({ cards: [] });
		const html = d.renderShell('/dashboard');
		expect(html).toContain('htmx.org');
		expect(html).toContain('chart.js');
	});

	it('defaults the title to "Dashboard"', () => {
		const html = new Dashboard({ cards: [] }).renderShell('/x');
		expect(html).toContain('<title>Dashboard</title>');
		expect(html).toContain('<h1>Dashboard</h1>');
	});

	it('uses the supplied base path in hx-get attrs', () => {
		const d = new Dashboard({ cards: [{ id: 'k', render: () => '' }] });
		expect(d.renderShell('/admin/dash')).toContain('hx-get="/admin/dash/c/k"');
	});

	it('escapes quotes, angle brackets, ampersands in titles', () => {
		const html = new Dashboard({ title: `&"<>'`, cards: [] }).renderShell('/x');
		expect(html).toContain('&amp;');
		expect(html).toContain('&quot;');
		expect(html).toContain('&lt;');
		expect(html).toContain('&gt;');
		expect(html).toContain('&#39;');
	});

	it('renders an empty grid when no cards', () => {
		const html = new Dashboard({ cards: [] }).renderShell('/x');
		expect(html).toContain('<div class="grid"></div>');
	});

	it('includes hx-swap=innerHTML so cards replace their loading placeholder', () => {
		const d = new Dashboard({ cards: [{ id: 'k', render: () => '' }] });
		expect(d.renderShell('/x')).toContain('hx-swap="innerHTML"');
	});

	it('honors a custom theme string in <style>', () => {
		const d = new Dashboard({ cards: [], theme: '/* mine */ body { color: red; }' });
		const html = d.renderShell('/x');
		expect(html).toContain('<style>/* mine */ body { color: red; }</style>');
	});

	it('falls back to the default theme when none provided', () => {
		const html = new Dashboard({ cards: [] }).renderShell('/x');
		// Default theme references the dark-slate background by hex; check a stable substring.
		expect(html).toContain('background: #0f172a');
	});
});

describe('default card builders', () => {
	it('return Card objects with id and render', () => {
		for (const c of [summaryCard(), queueCard(), funnelCard(), messagesChartCard()]) {
			expect(typeof c.id).toBe('string');
			expect(typeof c.render).toBe('function');
		}
	});

	it('defaultCards.all() returns the full set', () => {
		const all = defaultCards.all();
		expect(all.length).toBe(9);
		expect(all.map((c) => c.id)).toEqual(['summary', 'queue', 'dau', 'messages', 'funnel', 'engagement', 'plans', 'gate_conversion', 'churn']);
	});

	it('defaultCards.core() returns 4 essential cards', () => {
		expect(defaultCards.core().length).toBe(4);
	});

	it('defaultCards.summary() returns 1 card', () => {
		expect(defaultCards.summary().length).toBe(1);
	});

	it('card builders accept a custom id', () => {
		expect(summaryCard({ id: 'custom' }).id).toBe('custom');
	});

	it('default ids are stable', () => {
		expect(summaryCard().id).toBe('summary');
		expect(queueCard().id).toBe('queue');
		expect(funnelCard().id).toBe('funnel');
		expect(messagesChartCard().id).toBe('messages');
	});

	it('default refreshSeconds are non-zero and pickable', () => {
		expect(summaryCard().refreshSeconds).toBe(60);
		expect(queueCard().refreshSeconds).toBe(30);
		expect(funnelCard().refreshSeconds).toBe(60);
		expect(messagesChartCard().refreshSeconds).toBe(60);
	});

	it('builders accept refreshSeconds override', () => {
		expect(summaryCard({ refreshSeconds: 15 }).refreshSeconds).toBe(15);
	});

	it('defaultCards.core() is the four essentials', () => {
		const core = defaultCards.core();
		expect(core.map((c) => c.id)).toEqual(['summary', 'queue', 'messages', 'funnel']);
	});

	it('defaultCards.all() returns fresh card instances each call', () => {
		const a = defaultCards.all();
		const b = defaultCards.all();
		expect(a).not.toBe(b);
		expect(a[0]).not.toBe(b[0]);
	});
});
