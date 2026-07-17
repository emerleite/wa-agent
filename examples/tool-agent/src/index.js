/**
 * tool-agent — minimal AgentLoop example (v0.11).
 *
 * A WhatsApp bot that manages appointments via three tools. Demonstrates the
 * full wire-up: webhook → Agent (queue + audit) → AgentLoop (tool calls +
 * memory) → reply. About 130 lines.
 *
 * What this shows that other examples don't:
 *  - Multi-step tool loop with Zod-validated inputs
 *  - `ConversationMemory` (agent_turns) as machine-state alongside `MessageLog`
 *  - `AICallLedger` correlating LLM calls by turnId
 *  - Vercel AI SDK adapter (wa-agent/ai-sdk) — swap the provider by
 *    changing one import
 *
 * Run:
 *   wrangler d1 create tool-agent
 *   # copy the id into wrangler.toml, then:
 *   wrangler d1 migrations apply tool-agent --migrations-dir ../../migrations
 *   # add secrets (Meta + GEMINI_API_KEY), then:
 *   wrangler deploy
 */
import { Hono } from 'hono';
import { z } from 'zod';
import { google } from '@ai-sdk/google';
import {
	Agent,
	mountWebhook,
	AgentLoop,
	ConversationMemory,
	ToolRegistry,
	AICallLedger,
} from 'wa-agent';
import { createAISDKAgentLLM } from 'wa-agent/ai-sdk';

const SYSTEM_PROMPT = `You are ScheduleBot, an appointment assistant.

SCOPE (strict): you may only help with:
  1. Booking a new appointment
  2. Listing the user's upcoming appointments
  3. Cancelling an appointment by id

If the user asks for anything else, politely refuse and steer them back to
these three tasks. Never engage with general questions or opinions.

When booking, ALWAYS confirm day + time before calling book_appointment. Use
ISO day format (YYYY-MM-DD) and 24h time (HH:MM). If the user gives you a
relative day ("tomorrow", "next Monday"), resolve it to an ISO date first
based on today's date, then confirm.

Be concise. Two short sentences maximum per reply.`;

// ---------- Tools ----------

const bookAppointment = {
	name: 'book_appointment',
	description: 'Book a new appointment. Fails if the slot is already taken.',
	inputSchema: z.object({
		day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be ISO YYYY-MM-DD'),
		time: z.string().regex(/^\d{2}:\d{2}$/, 'must be HH:MM in 24h'),
	}),
	execute: async ({ day, time }, { env, whatsapp }) => {
		const existing = await env.DB.prepare(
			'SELECT id FROM appointments WHERE whatsapp=? AND day=? AND time=?',
		).bind(whatsapp, day, time).first();
		if (existing) return `Slot ${day} ${time} already booked for this user.`;
		const id = crypto.randomUUID();
		await env.DB.prepare(
			'INSERT INTO appointments (id, whatsapp, day, time, created_at) VALUES (?, ?, ?, ?, datetime("now"))',
		).bind(id, whatsapp, day, time).run();
		return `Booked (id: ${id}) on ${day} at ${time}.`;
	},
};

const listAppointments = {
	name: 'list_appointments',
	description: "List the current user's upcoming appointments with their ids.",
	inputSchema: z.object({}),
	execute: async (_input, { env, whatsapp }) => {
		const { results } = await env.DB.prepare(
			'SELECT id, day, time FROM appointments WHERE whatsapp=? ORDER BY day, time',
		).bind(whatsapp).all();
		if (results.length === 0) return 'No appointments booked.';
		return results.map((r) => `- ${r.day} ${r.time} (id: ${r.id})`).join('\n');
	},
};

const cancelAppointment = {
	name: 'cancel_appointment',
	description: 'Cancel an appointment by its id. Ask the user for the id (via list_appointments) if unsure.',
	inputSchema: z.object({ id: z.string().uuid() }),
	execute: async ({ id }, { env, whatsapp }) => {
		const row = await env.DB.prepare(
			'SELECT id FROM appointments WHERE id=? AND whatsapp=?',
		).bind(id, whatsapp).first();
		if (!row) return `No appointment ${id} for this user. Call list_appointments to see valid ids.`;
		await env.DB.prepare('DELETE FROM appointments WHERE id=?').bind(id).run();
		return `Cancelled appointment ${id}.`;
	},
};

// ---------- Wire-up ----------

let app, agent, loop;

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

	loop = new AgentLoop({
		llm: createAISDKAgentLLM(google('gemini-2.5-flash')),
		tools: new ToolRegistry([bookAppointment, listAppointments, cancelAppointment]),
		memory: new ConversationMemory({ db: env.DB }),
		ledger: new AICallLedger({ db: env.DB }),
		maxSteps: 8,
	});

	agent.command(['help', 'h', '?'], async ({ reply }) => {
		await reply.text('I can book, list, and cancel appointments. Try "book Monday 10am".');
	});

	agent.onText(async ({ text, user, reply }) => {
		const result = await loop.run({
			whatsapp: user.whatsapp,
			userText: text,
			systemPrompt: SYSTEM_PROMPT,
			context: { env, whatsapp: user.whatsapp },
		});
		if (result.finishReason === 'error') {
			await reply.text('Sorry, I hit a problem. Please try again in a moment.');
			return;
		}
		await reply.text(result.text || '(no reply)');
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
