/**
 * echo-bot — minimal wa-agent example.
 *
 * Replies to anything with the user's own text. Demonstrates only the core
 * webhook → coalesce → reply loop. No AI, no broadcast, no plans.
 */
import { Hono } from 'hono';
import { Agent, mountWebhook } from '@emerleite/wa-agent';

// Built lazily on the first request because env bindings are not available at module-load time.
let app, agent;

function init(env) {
	if (app) return;
	app = new Hono();
	agent = new Agent({
		whatsapp: {
			endpoint: env.META_WA_ENDPOINT,
			token: env.META_WA_TOKEN,
			verifyToken: env.META_WH_TOKEN,
			appSecret: env.META_APP_SECRET,
		},
		db: env.DB,
	});

	agent.command(['help', 'h', '?'], async ({ reply }) => {
		await reply.text('Send any message and I will echo it back. Type "stop" to opt out.');
	});
	agent.command(['stop'], async ({ user, reply, leads }) => {
		await leads.optOut(user.whatsapp);
		await reply.text('You have been opted out.');
	});
	agent.onText(async ({ text, reply }) => {
		await reply.text(`You said: ${text}`);
	});

	mountWebhook(agent, app);
}

export default {
	fetch: (req, env, ctx) => {
		init(env);
		return app.fetch(req, env, ctx);
	},
	scheduled: (event, env, ctx) => {
		init(env);
		return agent.scheduled(event, env, ctx);
	},
};
