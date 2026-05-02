/**
 * Modular dashboard for wa-agent — HTMX shell + registered cards.
 */

export interface CardContext {
	db: D1Database;
	env: Record<string, unknown>;
	query: Record<string, string | undefined>;
}

export interface Card {
	id: string;
	refreshSeconds?: number;
	render: (ctx: CardContext) => string | Promise<string>;
}

export interface DashboardOptions {
	title?: string;
	cards?: Card[];
	auth?: { username: string; password: string } | null;
	theme?: string | null;
}

/**
 * Minimal subset of Hono we touch. Avoids a hard import.
 */
export interface HonoLike {
	use(path: string, mw: (c: unknown, next: () => Promise<void>) => Promise<unknown>): unknown;
	get(path: string, handler: (c: HonoContextLike) => unknown): unknown;
}
export interface HonoContextLike {
	html(body: string): unknown;
	env: { DB: D1Database; [k: string]: unknown };
	req: { query(): Record<string, string | undefined> };
}

export class Dashboard {
	readonly title: string;
	readonly cards: Card[];
	readonly auth: { username: string; password: string } | null;
	readonly theme: string;

	constructor({ title = 'Dashboard', cards = [], auth = null, theme = null }: DashboardOptions) {
		this.title = title;
		this.cards = cards;
		this.auth = auth;
		this.theme = theme || DEFAULT_THEME;
	}

	async mount(app: HonoLike, base: string = '/dashboard'): Promise<void> {
		if (this.auth) {
			const { basicAuth } = (await import('hono/basic-auth')) as unknown as {
				basicAuth: (opts: { username: string; password: string }) => (c: unknown, next: () => Promise<void>) => Promise<unknown>;
			};
			app.use(`${base}/*`, basicAuth({ username: this.auth.username, password: this.auth.password }));
			app.use(base, basicAuth({ username: this.auth.username, password: this.auth.password }));
		}

		app.get(base, (c) => c.html(this.renderShell(base)));

		for (const card of this.cards) {
			app.get(`${base}/c/${card.id}`, async (c) => {
				try {
					const html = await card.render({ db: c.env.DB, env: c.env, query: c.req.query() });
					return c.html(html);
				} catch (e) {
					return c.html(`<div class="card-error">${escapeHtml(e instanceof Error ? e.message : String(e))}</div>`);
				}
			});
		}
	}

	renderShell(base: string): string {
		const cardDivs = this.cards
			.map((card) => {
				const trigger = card.refreshSeconds ? `load, every ${card.refreshSeconds}s` : 'load';
				return `<div class="card" hx-get="${base}/c/${card.id}" hx-trigger="${trigger}" hx-swap="innerHTML">
					<div class="loading">Loading…</div>
				</div>`;
			})
			.join('\n');

		return `<!DOCTYPE html>
<html>
<head>
	<meta charset="UTF-8" />
	<meta name="viewport" content="width=device-width, initial-scale=1.0" />
	<title>${escapeHtml(this.title)}</title>
	<script src="https://cdn.jsdelivr.net/npm/chart.js@4"></script>
	<script src="https://unpkg.com/htmx.org@2.0.4"></script>
	<style>${this.theme}</style>
</head>
<body>
	<h1>${escapeHtml(this.title)}</h1>
	<div class="grid">${cardDivs}</div>
</body>
</html>`;
	}
}

// ----- Default cards -----

export function summaryCard({ id = 'summary', title = 'Overview', refreshSeconds = 60 } = {}): Card {
	return {
		id,
		refreshSeconds,
		async render({ db }) {
			const results = await db.batch<Record<string, number>>([
				db.prepare(`SELECT COUNT(*) as total, SUM(opt_in) as opt_in FROM leads`),
				db.prepare(`SELECT COUNT(*) as total, COUNT(CASE WHEN created_at >= datetime('now', '-1 day') THEN 1 END) as last_24h FROM messages`),
				db.prepare(`SELECT COUNT(*) as total, COUNT(CASE WHEN end_time > datetime('now') THEN 1 END) as active FROM message_windows`),
			]);
			const l = results[0]?.results?.[0] ?? {};
			const m = results[1]?.results?.[0] ?? {};
			const w = results[2]?.results?.[0] ?? {};
			return kpiCard(title, [
				['Leads', l.total ?? 0],
				['Opt-in', l.opt_in ?? 0],
				['Msgs (24h)', m.last_24h ?? 0],
				['Active windows', w.active ?? 0],
			]);
		},
	};
}

export function queueCard({ id = 'queue', title = 'Queue', refreshSeconds = 30 } = {}): Card {
	return {
		id,
		refreshSeconds,
		async render({ db }) {
			const r = await db.prepare(`SELECT status, COUNT(*) as count FROM message_queue GROUP BY status`).all<{ status: string; count: number }>();
			const rows = (r.results ?? [])
				.map((x) => `<tr><td>${escapeHtml(x.status)}</td><td style="text-align:right">${x.count}</td></tr>`)
				.join('');
			return `<h2>${escapeHtml(title)}</h2><table><thead><tr><th>Status</th><th style="text-align:right">Count</th></tr></thead><tbody>${rows || '<tr><td colspan=2 class="loading">empty</td></tr>'}</tbody></table>`;
		},
	};
}

export function funnelCard({ id = 'funnel', title = 'Funnel', refreshSeconds = 60 } = {}): Card {
	return {
		id,
		refreshSeconds,
		async render({ db }) {
			const r = await db.prepare(`SELECT funnel_state, COUNT(*) as count FROM leads GROUP BY funnel_state`).all<{ funnel_state: string; count: number }>();
			const rows = r.results ?? [];
			const max = Math.max(...rows.map((x) => x.count), 1);
			const bars = rows
				.map(
					(x) =>
						`<div class="bar-row"><span class="bar-label">${escapeHtml(x.funnel_state)}</span><div class="bar-fill" style="width:${(x.count / max) * 100}%"></div><span class="bar-value">${x.count}</span></div>`
				)
				.join('');
			return `<h2>${escapeHtml(title)}</h2>${bars || '<div class="loading">empty</div>'}`;
		},
	};
}

export function messagesChartCard({ id = 'messages', title = 'Messages (7d)', refreshSeconds = 60, days = 7 } = {}): Card {
	return {
		id,
		refreshSeconds,
		async render({ db }) {
			const r = await db
				.prepare(
					`SELECT date(created_at) as day, COUNT(*) as total
					 FROM messages WHERE created_at >= date('now', '-${days} days')
					 GROUP BY date(created_at) ORDER BY day`
				)
				.all<{ day: string; total: number }>();
			const rows = r.results ?? [];
			const labels = rows.map((x) => x.day.slice(5));
			const values = rows.map((x) => x.total);
			const cid = `c_${id}_${Date.now()}`;
			return `<h2>${escapeHtml(title)}</h2><canvas id="${cid}"></canvas>
				<script>new Chart(document.getElementById('${cid}'), {
					type: 'bar',
					data: { labels: ${JSON.stringify(labels)}, datasets: [{ data: ${JSON.stringify(values)}, backgroundColor: '#8b5cf6', borderRadius: 4 }] },
					options: { responsive: true, plugins: { legend: { display: false } }, scales: { x: { ticks: { color: '#64748b' }, grid: { display: false } }, y: { ticks: { color: '#64748b' }, beginAtZero: true } } }
				});</script>`;
		},
	};
}

/**
 * Daily-active-users line chart with overlay of new users per day.
 * Reads `messages` for DAU and `leads.created_at` for new-user counts.
 */
export function dauCard({ id = 'dau', title = 'Daily active users', refreshSeconds = 60, days = 7 } = {}): Card {
	return {
		id,
		refreshSeconds,
		async render({ db }) {
			const results = await db.batch<{ day: string; users?: number; new_leads?: number }>([
				db.prepare(
					`SELECT date(created_at) as day, COUNT(DISTINCT whatsapp) as users
					 FROM messages WHERE created_at >= date('now', '-${days} days')
					 GROUP BY date(created_at) ORDER BY day`
				),
				db.prepare(
					`SELECT date(created_at) as day, COUNT(*) as new_leads
					 FROM leads WHERE created_at >= date('now', '-${days} days')
					 GROUP BY date(created_at) ORDER BY day`
				),
			]);
			const dau = results[0]?.results ?? [];
			const newUsers = results[1]?.results ?? [];
			const labels = dau.map((x) => x.day.slice(5));
			const dauValues = dau.map((x) => x.users ?? 0);
			const newValues = labels.map((label) => {
				const match = newUsers.find((d) => d.day.slice(5) === label);
				return match?.new_leads ?? 0;
			});
			const cid = `c_${id}_${Date.now()}`;
			return `<h2>${escapeHtml(title)}</h2><canvas id="${cid}"></canvas>
				<script>new Chart(document.getElementById('${cid}'), {
					type: 'line',
					data: {
						labels: ${JSON.stringify(labels)},
						datasets: [
							{ label: 'Active', data: ${JSON.stringify(dauValues)}, borderColor: '#3b82f6', backgroundColor: 'rgba(59,130,246,0.1)', fill: true, tension: 0.3 },
							{ label: 'New', data: ${JSON.stringify(newValues)}, borderColor: '#10b981', backgroundColor: 'rgba(16,185,129,0.1)', fill: true, tension: 0.3 }
						]
					},
					options: { responsive: true, plugins: { legend: { labels: { color: '#94a3b8' } } }, scales: { x: { ticks: { color: '#64748b' } }, y: { ticks: { color: '#64748b' }, beginAtZero: true } } }
				});</script>`;
		},
	};
}

/**
 * Re-engagement response rate over the last `days`. Reads `engagement_answers`
 * (yes/no) and `broadcast_log` (sent count) for the given `topicId`.
 */
export function engagementCard({
	id = 'engagement',
	title = 'Engagement (7d)',
	refreshSeconds = 60,
	days = 7,
	topicId = 1,
	channel = 'engagement',
} = {}): Card {
	return {
		id,
		refreshSeconds,
		async render({ db }) {
			const results = await db.batch<Record<string, number | string>>([
				db.prepare(
					`SELECT answer, COUNT(*) as count FROM engagement_answers
					 WHERE engagement_id = ? AND date >= date('now', '-${days} days') GROUP BY answer`
				).bind(topicId),
				db.prepare(
					`SELECT COUNT(*) as sent FROM broadcast_log WHERE channel = ? AND date >= date('now', '-${days} days')`
				).bind(channel),
			]);
			const answers = results[0]?.results ?? [];
			let yes = 0;
			let no = 0;
			for (const row of answers) {
				if (row.answer === 'a') yes = (row.count as number) ?? 0;
				else if (row.answer === 'b') no = (row.count as number) ?? 0;
			}
			const sent = (results[1]?.results?.[0]?.sent as number) ?? 0;
			const ignored = Math.max(0, sent - yes - no);
			const responseRate = sent > 0 ? Math.round(((yes + no) / sent) * 100) : 0;
			const max = Math.max(yes, no, ignored, 1);

			const bar = (label: string, value: number, color: string) =>
				`<div class="bar-row"><span class="bar-label">${escapeHtml(label)}</span><div class="bar-fill" style="width:${(value / max) * 100}%; background:${color}"></div><span class="bar-value">${value}</span></div>`;

			return `<h2>${escapeHtml(title)}</h2>
				<div class="kpi"><div class="kpi-item"><div class="kpi-value">${responseRate}%</div><div class="kpi-label">Response rate</div></div>
				<div class="kpi-item"><div class="kpi-value">${sent}</div><div class="kpi-label">Sent</div></div></div>
				<div style="margin-top:12px">
					${bar('Yes', yes, '#10b981')}
					${bar('No', no, '#ef4444')}
					${bar('Ignored', ignored, '#64748b')}
				</div>`;
		},
	};
}

/**
 * Sequential-plan enrollment table with completion rate per plan.
 * Reads `plans` + `user_plans`.
 */
export function plansCard({ id = 'plans', title = 'Plans', refreshSeconds = 60 } = {}): Card {
	return {
		id,
		refreshSeconds,
		async render({ db }) {
			const r = await db
				.prepare(
					`SELECT p.title, p.duration_days,
					   COUNT(CASE WHEN up.is_active = 1 THEN 1 END) as active,
					   COUNT(CASE WHEN up.completed_at IS NOT NULL THEN 1 END) as completed,
					   COUNT(*) as total
					 FROM user_plans up
					 JOIN plans p ON p.id = up.plan_id
					 GROUP BY up.plan_id`
				)
				.all<{ title: string; duration_days: number; active: number; completed: number; total: number }>();
			const plans = r.results ?? [];
			if (!plans.length) return `<h2>${escapeHtml(title)}</h2><div class="loading">No active plans</div>`;
			const head = `<thead><tr><th>Plan</th><th>Days</th><th>Active</th><th>Done</th><th>Total</th><th>%</th></tr></thead>`;
			const body = plans
				.map((p) => {
					const pct = p.total ? Math.round((p.completed / p.total) * 100) : 0;
					return `<tr><td>${escapeHtml(p.title)}</td><td>${p.duration_days}</td><td>${p.active}</td><td>${p.completed}</td><td>${p.total}</td><td>${pct}%</td></tr>`;
				})
				.join('');
			return `<h2>${escapeHtml(title)}</h2><table>${head}<tbody>${body}</tbody></table>`;
		},
	};
}

/**
 * Churn — opt-in users with no open message window. Useful early-warning
 * indicator: when this number trends up, your re-engagement isn't keeping
 * users inside the 24h window.
 */
export function churnCard({ id = 'churn', title = 'Churn (opt-in, no window)', refreshSeconds = 60 } = {}): Card {
	return {
		id,
		refreshSeconds,
		async render({ db }) {
			const r = await db
				.prepare(
					`SELECT COUNT(*) as churned
					 FROM leads l
					 LEFT JOIN message_windows mw ON mw.whatsapp = l.whatsapp AND mw.end_time > datetime('now')
					 WHERE l.opt_in = 1 AND mw.id IS NULL`
				)
				.first<{ churned: number }>();
			return kpiCard(title, [['Churned', r?.churned ?? 0]]);
		},
	};
}

export const defaultCards = {
	all: (): Card[] => [summaryCard(), queueCard(), dauCard(), messagesChartCard(), funnelCard(), engagementCard(), plansCard(), churnCard()],
	summary: (): Card[] => [summaryCard()],
	core: (): Card[] => [summaryCard(), queueCard(), messagesChartCard(), funnelCard()],
};

function kpiCard(title: string, items: Array<[string, string | number]>): string {
	const tiles = items
		.map(
			([label, value]) =>
				`<div class="kpi-item"><div class="kpi-value">${escapeHtml(String(value))}</div><div class="kpi-label">${escapeHtml(label)}</div></div>`
		)
		.join('');
	return `<h2>${escapeHtml(title)}</h2><div class="kpi">${tiles}</div>`;
}

function escapeHtml(s: string): string {
	return String(s)
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');
}

const DEFAULT_THEME = `
	* { margin: 0; padding: 0; box-sizing: border-box; }
	body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0f172a; color: #e2e8f0; padding: 24px; }
	h1 { font-size: 1.5rem; margin-bottom: 24px; color: #f8fafc; }
	.grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 20px; margin-bottom: 24px; }
	.card { background: #1e293b; border-radius: 12px; padding: 20px; border: 1px solid #334155; }
	.card h2 { font-size: 0.85rem; text-transform: uppercase; letter-spacing: 0.05em; color: #94a3b8; margin-bottom: 12px; }
	.kpi { display: flex; gap: 16px; flex-wrap: wrap; }
	.kpi-item { flex: 1; min-width: 80px; }
	.kpi-value { font-size: 1.8rem; font-weight: 700; color: #f8fafc; }
	.kpi-label { font-size: 0.75rem; color: #94a3b8; margin-top: 2px; }
	table { width: 100%; border-collapse: collapse; }
	th, td { text-align: left; padding: 8px 12px; border-bottom: 1px solid #334155; }
	th { font-size: 0.75rem; text-transform: uppercase; color: #94a3b8; }
	td { font-size: 0.9rem; }
	.loading { color: #64748b; font-size: 0.85rem; padding: 12px; }
	canvas { max-height: 250px; }
	.bar-row { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
	.bar-label { font-size: 0.8rem; color: #94a3b8; min-width: 100px; }
	.bar-fill { height: 18px; background: #3b82f6; border-radius: 4px; min-width: 2px; }
	.bar-value { font-size: 0.8rem; color: #e2e8f0; }
	.card-error { color: #f87171; }
`;
