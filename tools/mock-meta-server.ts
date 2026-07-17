/**
 * Mock Meta Graph API — local server that impersonates graph.facebook.com so
 * your Worker can be developed and tested without burning a real Meta token
 * or spamming real WhatsApp numbers.
 *
 * USAGE
 *   npx tsx node_modules/wa-agent/tools/mock-meta-server.ts
 *   # or, if you have wa-agent checked out:
 *   npm run mock:meta
 *
 * Then point your Worker at it via `.dev.vars`:
 *   META_GRAPH_BASE_URL=http://localhost:4000
 *
 * Every inbound call to graph.facebook.com is rerouted to this server. Each
 * request is logged to stdout AND retained in memory so you can introspect
 * what your Worker tried to send.
 *
 * SIMULATED ENDPOINTS
 *   POST /v{N}/:phone_number_id/messages    — send (text, image, template)
 *   GET  /v{N}/debug_token                  — token info (valid + scopes)
 *   GET  /v{N}/:id                          — WABA info OR media metadata
 *                                             (disambiguated by ?fields=)
 *   GET  /v{N}/:media_id/binary             — fake media binary (1×1 jpeg)
 *   POST /v{N}/:waba_id/message_templates   — create template (auto-APPROVED)
 *   GET  /v{N}/:waba_id/message_templates   — list created templates
 *   DEL  /v{N}/:waba_id/message_templates   — delete by ?name=
 *   GET  /v{N}/:app_id/subscriptions        — current webhook URL
 *   POST /v{N}/:app_id/subscriptions        — set webhook URL
 *   GET  /v{N}/:waba_id/subscribed_apps     — apps subscribed to WABA
 *   POST /v{N}/:waba_id/subscribed_apps     — subscribe app to WABA
 *   DEL  /v{N}/:waba_id/subscribed_apps     — unsubscribe
 *
 * INTROSPECTION ENDPOINTS (you)
 *   GET  /__received                        — list all received calls
 *   POST /__reset                           — clear received + templates
 *
 * Port: $MOCK_META_PORT or 4000.
 *
 * NEEDS PEER DEPS: hono, @hono/node-server, tsx (for direct .ts execution).
 */
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { inspect } from 'node:util';

interface ReceivedCall {
	at: string;
	method: string;
	path: string;
	query: Record<string, string>;
	body: unknown;
}

const received: ReceivedCall[] = [];
const templates: Array<Record<string, unknown>> = [];

const app = new Hono();

app.use('*', async (c, next) => {
	const text = await c.req.text().catch(() => '');
	let body: unknown = text;
	try {
		body = text ? JSON.parse(text) : '';
	} catch {
		// might be form-urlencoded
		body = text;
	}
	const entry: ReceivedCall = {
		at: new Date().toISOString(),
		method: c.req.method,
		path: c.req.path,
		query: Object.fromEntries(new URL(c.req.url).searchParams),
		body,
	};
	received.push(entry);

	const payload = body && (typeof body !== 'string' || body.length > 0) ? body : entry.query;
	const formatted = inspect(payload, {
		depth: null,
		colors: process.stdout.isTTY,
		breakLength: 100,
		compact: 3,
	});
	console.log(`[${entry.at}] ${entry.method} ${entry.path}`);
	console.log(formatted);
	await next();
});

// ---------- Send message (text/image/template) ----------
app.post('/:version/:phone_number_id/messages', (c) => {
	const mockWamid = `wamid.MOCK${Date.now()}${Math.random().toString(36).slice(2, 8)}`;
	return c.json({
		messaging_product: 'whatsapp',
		contacts: [{ input: 'mock', wa_id: 'mock' }],
		messages: [{ id: mockWamid }],
	});
});

// ---------- Debug token (must precede the generic /:version/:id route) ----------
app.get('/:version/debug_token', (c) => {
	return c.json({
		data: {
			app_id: 'mock-app',
			type: 'SYSTEM',
			scopes: ['whatsapp_business_messaging', 'whatsapp_business_management'],
			expires_at: 0,
			is_valid: true,
			granular_scopes: [],
		},
	});
});

// ---------- GET /:version/:id — decides between WABA info or media metadata ----------
// Disambiguated by the ?fields= query parameter:
//  - With ?fields=message_template_namespace (typical of `meta:check`) → WABA info
//  - Without fields → assume :id is a media_id, return metadata + binary URL
app.get('/:version/:id', (c) => {
	const { version, id } = c.req.param();
	const fields = c.req.query('fields') ?? '';
	if (fields.includes('message_template_namespace') || fields.includes('timezone_id')) {
		return c.json({
			id,
			name: 'Mock WABA',
			timezone_id: 38,
			message_template_namespace: 'mock-namespace',
		});
	}
	return c.json({
		id,
		messaging_product: 'whatsapp',
		mime_type: 'image/jpeg',
		sha256: 'mocksha',
		file_size: 12345,
		url: `http://localhost:${process.env.MOCK_META_PORT ?? 4000}/${version}/${id}/binary`,
	});
});

// Fake binary (1x1 transparent JPEG in base64)
app.get('/:version/:media_id/binary', () => {
	const transparent1x1Jpeg = Uint8Array.from(
		atob(
			'/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEB/9k=',
		),
		(c2) => c2.charCodeAt(0),
	);
	return new Response(transparent1x1Jpeg, {
		headers: { 'content-type': 'image/jpeg' },
	});
});

// ---------- Templates ----------
app.post('/:version/:waba_id/message_templates', async (c) => {
	const body = (await c.req.json()) as Record<string, unknown>;
	const id = `mock-template-${Date.now()}`;
	const tmpl = { id, status: 'APPROVED', ...body };
	templates.push(tmpl);
	return c.json(tmpl);
});

app.get('/:version/:waba_id/message_templates', (c) => {
	return c.json({ data: templates });
});

app.delete('/:version/:waba_id/message_templates', (c) => {
	const name = c.req.query('name');
	const idx = templates.findIndex((t) => t.name === name);
	if (idx >= 0) templates.splice(idx, 1);
	return c.json({ success: true });
});

// ---------- Webhook subscriptions (app-level) ----------
let currentSubscription = {
	callback_url: '',
	fields: [] as string[],
	active: false,
};

app.get('/:version/:app_id/subscriptions', (c) => {
	return c.json({ data: currentSubscription.active ? [currentSubscription] : [] });
});

app.post('/:version/:app_id/subscriptions', async (c) => {
	const body = await c.req.parseBody();
	currentSubscription = {
		callback_url: String(body.callback_url ?? ''),
		fields: String(body.fields ?? '').split(','),
		active: true,
	};
	return c.json({ success: true });
});

// ---------- WABA subscribed apps ----------
app.get('/:version/:waba_id/subscribed_apps', (c) => {
	return c.json({ data: [{ whatsapp_business_api_data: { id: 'mock-app' } }] });
});

app.post('/:version/:waba_id/subscribed_apps', (c) => c.json({ success: true }));
app.delete('/:version/:waba_id/subscribed_apps', (c) => c.json({ success: true }));

// ---------- Introspection ----------
app.get('/__received', (c) => c.json({ count: received.length, calls: received }));
app.post('/__reset', (c) => {
	received.length = 0;
	templates.length = 0;
	return c.json({ ok: true });
});

const PORT = Number(process.env.MOCK_META_PORT ?? 4000);
console.log(`🟢 mock-meta-server listening on http://localhost:${PORT}`);
console.log(`   Point your Worker at it via .dev.vars:`);
console.log(`     META_GRAPH_BASE_URL=http://localhost:${PORT}`);
console.log(`   Introspect: curl http://localhost:${PORT}/__received | jq`);
serve({ fetch: app.fetch, port: PORT });
