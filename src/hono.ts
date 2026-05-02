/**
 * Hono integration — `mountWebhook(agent, app, '/wa')` registers webhook routes.
 *
 * Hono is optional; the plain agent works with raw fetch handlers.
 */
import type { Agent } from './agent.js';

interface HonoLike {
	get(path: string, handler: (c: HonoContextLike) => unknown): unknown;
	post(path: string, handler: (c: HonoContextLike) => unknown): unknown;
}

interface HonoContextLike {
	req: {
		query(name: string): string | undefined;
		header(name: string): string | undefined;
		arrayBuffer(): Promise<ArrayBuffer>;
	};
	executionCtx: { waitUntil(promise: Promise<unknown>): void };
	env: { DB: D1Database; [k: string]: unknown };
	text(body: string): unknown;
	json(body: unknown, status?: number): unknown;
}

export function mountWebhook(agent: Agent, app: HonoLike, base: string = '/wa'): void {
	const url = (p: string) => `${base}${p}`;

	app.get(url('/webhook'), (c) => {
		const result = agent.verifyChallenge({
			mode: c.req.query('hub.mode'),
			token: c.req.query('hub.verify_token'),
			challenge: c.req.query('hub.challenge'),
		});
		return result.ok && result.challenge ? c.text(result.challenge) : c.json({ error: 'Invalid' }, 403);
	});

	app.post(url('/webhook'), async (c) => {
		const raw = await c.req.arrayBuffer();
		const valid = await agent.verifySignature(raw, c.req.header('X-Hub-Signature-256'));
		if (!valid) return c.json({ error: 'Invalid signature' }, 403);

		const envelope = JSON.parse(new TextDecoder().decode(raw));
		const enqueued = await agent.enqueue(envelope);
		if (enqueued) {
			c.executionCtx.waitUntil(
				(async () => {
					await new Promise((r) => setTimeout(r, agent.queue.debounceSeconds * 1000));
					await agent.drain();
				})()
			);
		}
		return c.text('OK');
	});
}
