/**
 * Low-level LLM provider abstraction — used by `AIRouter` to fan a single
 * call out across multiple providers with circuit-breaker + budget control.
 *
 * Distinct from the higher-level `AIClient.chat()` (conversational turn
 * with thread state): an `LLMProvider.run(...)` is a single shot. Router
 * apps compose providers; conversational apps compose `AIClient`s.
 *
 * Ships two concrete implementations:
 * - `OpenAICompatProvider` — base class for any OpenAI Chat Completions-shaped
 *   API (Groq, Cerebras, OpenRouter, DeepInfra, Maritaca, Azure OpenAI).
 *   Apps subclass with their endpoint URL + API key env var.
 * - `WorkersAIProvider` — uses Cloudflare's `env.AI` binding directly
 *   (no fetch). In-process backstop when external providers are circuit-broken.
 */

export type ProviderErrorKind = '429' | '5xx' | 'network' | 'timeout' | 'parse' | 'config';

export interface ProviderRunArgs {
	system: string;
	user: string;
	maxTokens?: number;
	temperature?: number;
	timeoutMs?: number;
	/**
	 * Optional image attachments (v0.15). When present, the user message is
	 * rewritten as a multi-part `content` array (`[{type:'text'},{type:'image_url'}]`)
	 * so vision-capable models can see them. Providers that don't support
	 * multimodal input should drop this field silently.
	 *
	 * Provide either `url` (public URL Meta / your CDN can serve) or `b64`
	 * (base64-encoded bytes) with the image's `mimeType` (defaults to
	 * `image/jpeg`).
	 */
	images?: Array<{ url?: string; b64?: string; mimeType?: string }>;
}

export interface ProviderSuccess {
	ok: true;
	response: string;
	model: string;
	httpStatus: number | null;
	tokensIn: number | null;
	tokensOut: number | null;
}

export interface ProviderFailure {
	ok: false;
	errorKind: ProviderErrorKind;
	errorMessage: string;
	model: string;
	httpStatus?: number | null;
}

export type ProviderResult = ProviderSuccess | ProviderFailure;

export interface LLMProvider {
	readonly name: string;
	readonly model: string;
	run(args: ProviderRunArgs): Promise<ProviderResult>;
}

const TRUNCATE = 500;

function truncate(s: string): string {
	return s.length > TRUNCATE ? s.slice(0, TRUNCATE) : s;
}

function classifyHttpError(status: number): ProviderErrorKind | null {
	if (status === 429) return '429';
	if (status >= 400) return '5xx';
	return null;
}

export interface OpenAICompatProviderOptions {
	/** Logical name used in chain config + ledger rows. Required. */
	name: string;
	/** Full chat-completions URL (e.g. `https://api.groq.com/openai/v1/chat/completions`). */
	url: string;
	/** Bearer token. */
	apiKey: string;
	/** Model slug passed as the `model` field. */
	model: string;
	/** Extra request headers (e.g. OpenRouter's `HTTP-Referer`). */
	extraHeaders?: Record<string, string>;
	/** Extra body fields merged into the JSON payload. */
	extraBody?: Record<string, unknown>;
	/**
	 * Name of the "max tokens" field in the request body (v0.15). Default
	 * `'max_tokens'` (classic Chat Completions). Azure OpenAI reasoning-family
	 * deployments (`gpt-5-*`, `o1-*`) require `'max_completion_tokens'`. Set
	 * this once per provider instance so the router doesn't have to know.
	 */
	maxTokensField?: 'max_tokens' | 'max_completion_tokens';
	/**
	 * When `true` (v0.15), the `temperature` field is omitted from the request
	 * body. Reasoning-family models on Azure (`gpt-5.4-*`, `o1-*`) reject any
	 * non-default value and error. Default `false`.
	 */
	omitTemperature?: boolean;
}

/**
 * OpenAI Chat-Completions-compatible provider. Subclass or instantiate
 * directly per upstream API.
 *
 *   class GroqProvider extends OpenAICompatProvider {
 *     constructor(env) {
 *       super({
 *         name: 'groq_8b',
 *         url: 'https://api.groq.com/openai/v1/chat/completions',
 *         apiKey: env.GROQ_API_KEY,
 *         model: 'llama-3.1-8b-instant',
 *       });
 *     }
 *   }
 */
export class OpenAICompatProvider implements LLMProvider {
	readonly name: string;
	readonly url: string;
	readonly apiKey: string;
	readonly model: string;
	readonly extraHeaders: Record<string, string>;
	readonly extraBody: Record<string, unknown>;
	readonly maxTokensField: 'max_tokens' | 'max_completion_tokens';
	readonly omitTemperature: boolean;

	constructor(opts: OpenAICompatProviderOptions) {
		if (!opts.name) throw new Error('OpenAICompatProvider: name required');
		if (!opts.url) throw new Error('OpenAICompatProvider: url required');
		if (!opts.model) throw new Error('OpenAICompatProvider: model required');
		this.name = opts.name;
		this.url = opts.url;
		this.apiKey = opts.apiKey ?? '';
		this.model = opts.model;
		this.extraHeaders = opts.extraHeaders ?? {};
		this.extraBody = opts.extraBody ?? {};
		this.maxTokensField = opts.maxTokensField ?? 'max_tokens';
		this.omitTemperature = opts.omitTemperature ?? false;
	}

	async run({ system, user, maxTokens = 400, temperature = 0.6, timeoutMs = 5000, images }: ProviderRunArgs): Promise<ProviderResult> {
		if (!this.apiKey) {
			return { ok: false, errorKind: 'config', errorMessage: `${this.name}: apiKey not configured`, model: this.model };
		}
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), timeoutMs);
		const userContent =
			images && images.length
				? [
						{ type: 'text', text: user },
						...images.map((img) => ({
							type: 'image_url',
							image_url: {
								url: img.url ?? `data:${img.mimeType ?? 'image/jpeg'};base64,${img.b64 ?? ''}`,
							},
						})),
					]
				: user;
		const body: Record<string, unknown> = {
			model: this.model,
			messages: [
				{ role: 'system', content: system },
				{ role: 'user', content: userContent },
			],
			[this.maxTokensField]: maxTokens,
			...this.extraBody,
		};
		if (!this.omitTemperature) body.temperature = temperature;
		try {
			const res = await fetch(this.url, {
				method: 'POST',
				headers: {
					Authorization: `Bearer ${this.apiKey}`,
					'Content-Type': 'application/json',
					...this.extraHeaders,
				},
				body: JSON.stringify(body),
				signal: controller.signal,
			});
			clearTimeout(timer);
			const httpKind = classifyHttpError(res.status);
			let json: { choices?: Array<{ message?: { content?: string } }>; usage?: { prompt_tokens?: number; completion_tokens?: number }; error?: unknown } | null;
			try {
				json = (await res.json()) as typeof json;
			} catch (e) {
				return {
					ok: false,
					errorKind: 'parse',
					errorMessage: truncate(`malformed JSON: ${e instanceof Error ? e.message : String(e)}`),
					httpStatus: res.status,
					model: this.model,
				};
			}
			if (httpKind) {
				return {
					ok: false,
					errorKind: httpKind,
					errorMessage: truncate(JSON.stringify(json?.error ?? json)),
					httpStatus: res.status,
					model: this.model,
				};
			}
			const response = json?.choices?.[0]?.message?.content;
			if (typeof response !== 'string' || response.length === 0) {
				return {
					ok: false,
					errorKind: 'parse',
					errorMessage: truncate(`no message content: ${JSON.stringify(json).slice(0, 200)}`),
					httpStatus: res.status,
					model: this.model,
				};
			}
			return {
				ok: true,
				response,
				tokensIn: json?.usage?.prompt_tokens ?? null,
				tokensOut: json?.usage?.completion_tokens ?? null,
				model: this.model,
				httpStatus: res.status,
			};
		} catch (e) {
			clearTimeout(timer);
			if (e instanceof Error && e.name === 'AbortError') {
				return { ok: false, errorKind: 'timeout', errorMessage: `timeout after ${timeoutMs}ms`, model: this.model };
			}
			return {
				ok: false,
				errorKind: 'network',
				errorMessage: truncate(e instanceof Error ? e.message : 'network error'),
				model: this.model,
			};
		}
	}
}

/** Cloudflare Workers AI binding shape used by `WorkersAIProvider`. */
export interface WorkersAIBinding {
	run(model: string, input: unknown, opts?: { signal?: AbortSignal }): Promise<unknown>;
}

export interface WorkersAIProviderOptions {
	name: string;
	/** The `env.AI` binding from a Worker with `[ai]` in wrangler.toml. */
	ai: WorkersAIBinding | undefined;
	model: string;
}

/**
 * Cloudflare Workers AI provider — uses the `env.AI` binding in-process.
 * Useful as the last link in a fallback chain because it doesn't depend on
 * a remote endpoint being reachable.
 */
export class WorkersAIProvider implements LLMProvider {
	readonly name: string;
	readonly ai: WorkersAIBinding | undefined;
	readonly model: string;

	constructor(opts: WorkersAIProviderOptions) {
		if (!opts.name) throw new Error('WorkersAIProvider: name required');
		if (!opts.model) throw new Error('WorkersAIProvider: model required');
		this.name = opts.name;
		this.ai = opts.ai;
		this.model = opts.model;
	}

	async run({ system, user, maxTokens = 400, temperature = 0.6, timeoutMs = 5000 }: ProviderRunArgs): Promise<ProviderResult> {
		if (!this.ai) {
			return { ok: false, errorKind: 'config', errorMessage: `${this.name}: env.AI binding not available`, model: this.model };
		}
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), timeoutMs);
		try {
			const raw = (await this.ai.run(
				this.model,
				{
					messages: [
						{ role: 'system', content: system },
						{ role: 'user', content: user },
					],
					temperature,
					max_tokens: maxTokens,
				},
				{ signal: controller.signal },
			)) as { response?: unknown; usage?: { prompt_tokens?: number; completion_tokens?: number } } | null;
			clearTimeout(timer);
			const rawResponse = raw?.response;
			const response = typeof rawResponse === 'string'
				? rawResponse
				: rawResponse == null
					? null
					: JSON.stringify(rawResponse);
			if (!response || response.length === 0) {
				return {
					ok: false,
					errorKind: 'parse',
					errorMessage: truncate(`no response: ${JSON.stringify(raw).slice(0, 200)}`),
					model: this.model,
				};
			}
			return {
				ok: true,
				response,
				tokensIn: raw?.usage?.prompt_tokens ?? null,
				tokensOut: raw?.usage?.completion_tokens ?? null,
				model: this.model,
				httpStatus: 200,
			};
		} catch (e) {
			clearTimeout(timer);
			if (e instanceof Error && e.name === 'AbortError') {
				return { ok: false, errorKind: 'timeout', errorMessage: `timeout after ${timeoutMs}ms`, model: this.model };
			}
			const msg = e instanceof Error ? e.message : 'unknown';
			// Workers AI surfaces rate-limits as errors with these substrings.
			if (/rate.?limit|too many|429/i.test(msg)) {
				return { ok: false, errorKind: '429', errorMessage: truncate(msg), model: this.model };
			}
			return { ok: false, errorKind: 'network', errorMessage: truncate(msg), model: this.model };
		}
	}
}
