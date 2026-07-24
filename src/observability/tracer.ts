/**
 * Minimal tracing surface — one event per operation of interest.
 *
 * Design bias: pragmatic HTTP wrapper over Langfuse's ingestion API rather
 * than a full OpenTelemetry SDK. Cloudflare Workers can host OTel but the
 * configuration overhead vs. the wire format's simplicity isn't worth it for
 * the "log one trace per agent turn" use case that motivated this.
 *
 * Consumers implement `Tracer` if they want a different backend. Default is
 * `NoOpTracer` (drop all events) so wiring a `tracer?: Tracer` argument into
 * higher-level classes stays free when the env vars aren't set.
 *
 * Typical wire-up:
 *   const tracer = env.LANGFUSE_PUBLIC_KEY
 *     ? new LangfuseTracer({ publicKey, secretKey, host, environment })
 *     : new NoOpTracer();
 *
 *   const t0 = Date.now();
 *   const result = await loop.run({...});
 *   ctx.waitUntil(tracer.flushTrace({
 *     traceId: crypto.randomUUID(),
 *     name: 'agent.turn',
 *     input: { userText },
 *     output: { text: result.text, finishReason: result.finishReason },
 *     metadata: { steps: result.steps.length, whatsapp: user.whatsapp },
 *     startTime: t0,
 *     endTime: Date.now(),
 *   }));
 */

export interface TraceEvent {
	traceId: string;
	name: string;
	input?: unknown;
	output?: unknown;
	metadata?: Record<string, unknown>;
	/** Milliseconds since epoch. */
	startTime: number;
	/** Milliseconds since epoch. */
	endTime: number;
}

export interface Tracer {
	flushTrace(event: TraceEvent): Promise<void> | void;
}

export class NoOpTracer implements Tracer {
	flushTrace(_event: TraceEvent): void {
		// intentionally empty
	}
}

export interface LangfuseTracerOptions {
	publicKey: string;
	secretKey: string;
	/** Default `https://cloud.langfuse.com`. */
	host?: string;
	/** Environment tag (e.g. `production` / `staging`). */
	environment?: string;
	/** Injected for tests; defaults to global `fetch`. */
	fetch?: typeof fetch;
}

/**
 * Fire-and-forget POST to Langfuse's ingestion endpoint. Errors are logged
 * and swallowed — a tracing failure must never fail the request. Wrap the
 * call in `ctx.waitUntil(...)` at the caller for zero user-visible latency.
 */
export class LangfuseTracer implements Tracer {
	private readonly host: string;
	private readonly auth: string;
	private readonly environment: string | undefined;
	private readonly fetchImpl: typeof fetch;

	constructor(opts: LangfuseTracerOptions) {
		if (!opts.publicKey || !opts.secretKey) throw new Error('LangfuseTracer: publicKey and secretKey are required');
		this.host = (opts.host ?? 'https://cloud.langfuse.com').replace(/\/$/, '');
		this.auth = btoa(`${opts.publicKey}:${opts.secretKey}`);
		this.environment = opts.environment;
		this.fetchImpl = opts.fetch ?? fetch;
	}

	async flushTrace(ev: TraceEvent): Promise<void> {
		const startIso = new Date(ev.startTime).toISOString();
		const endIso = new Date(ev.endTime).toISOString();
		const body = {
			batch: [
				{
					id: crypto.randomUUID(),
					type: 'trace-create',
					timestamp: startIso,
					body: {
						id: ev.traceId,
						name: ev.name,
						input: ev.input,
						output: ev.output,
						metadata: ev.metadata,
						environment: this.environment,
						timestamp: startIso,
					},
				},
				{
					id: crypto.randomUUID(),
					type: 'span-create',
					timestamp: startIso,
					body: {
						id: crypto.randomUUID(),
						traceId: ev.traceId,
						name: ev.name,
						startTime: startIso,
						endTime: endIso,
						input: ev.input,
						output: ev.output,
						metadata: ev.metadata,
					},
				},
			],
		};

		try {
			await this.fetchImpl(`${this.host}/api/public/ingestion`, {
				method: 'POST',
				headers: {
					Authorization: `Basic ${this.auth}`,
					'Content-Type': 'application/json',
				},
				body: JSON.stringify(body),
			});
		} catch (err) {
			console.error('[LangfuseTracer] flushTrace failed', err);
		}
	}
}
