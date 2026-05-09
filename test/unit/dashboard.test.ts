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
});
