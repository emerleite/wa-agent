/**
 * Minimal OpenGraph-enriched HTML landing page for the `/` of a Worker.
 *
 * Meta's WhatsApp crawler renders a card preview for URL buttons in
 * templates. Without OG tags on the button's target, the preview shows the
 * bare `*.workers.dev` domain — bad look. This helper returns a tiny HTML
 * page with OG + Twitter meta tags + an optional human redirect. Consumers
 * wire it at `app.get('/', c => new Response(landingHtml({...}), {headers}))`.
 *
 * The `redirectTo` value drives a `<meta http-equiv="refresh">` — humans
 * bounce to your real site after `redirectDelaySeconds`; the WhatsApp
 * crawler stops at the first HTML response and reads OG tags there.
 */

export interface LandingHtmlOptions {
	/** OG title + `<title>`. Required. */
	title: string;
	/** OG description + Twitter description + `<meta name="description">`. Required. */
	description: string;
	/** `og:url` — canonical URL of this page. Required. */
	url: string;
	/** Where a human viewer should end up. When set, adds a meta-refresh redirect. */
	redirectTo?: string;
	/** Redirect delay in seconds. Default 2. Ignored when `redirectTo` is empty. */
	redirectDelaySeconds?: number;
	/** `og:site_name`. Default = title. */
	siteName?: string;
	/** `og:locale`. Default `pt_BR`. */
	locale?: string;
	/** BCP-47 language for `<html lang>`. Default `pt-BR`. */
	lang?: string;
	/** `og:image` URL. Optional. */
	image?: string;
	/** Emoji or short glyph shown above the title in the body. Default `⚡`. */
	glyph?: string;
	/**
	 * `Cache-Control` value returned in headers when consumers use the
	 * `landingResponse` helper. Default `public, max-age=3600` so Meta's
	 * crawler doesn't refetch every send.
	 */
	cacheControl?: string;
}

/**
 * Render the HTML string. `cacheControl` is ignored here — use it via
 * `landingResponse` when constructing the `Response`.
 */
export function landingHtml(opts: LandingHtmlOptions): string {
	const {
		title,
		description,
		url,
		redirectTo,
		redirectDelaySeconds = 2,
		siteName = title,
		locale = 'pt_BR',
		lang = 'pt-BR',
		image,
		glyph = '⚡',
	} = opts;
	const esc = escapeHtml;
	const refreshTag = redirectTo
		? `<meta http-equiv="refresh" content="${Math.max(0, Math.floor(redirectDelaySeconds))};url=${esc(redirectTo)}">`
		: '';
	const imageTag = image ? `<meta property="og:image" content="${esc(image)}">` : '';
	const redirectLine = redirectTo
		? `<p>Redirecionando para <a href="${esc(redirectTo)}">${esc(redirectTo.replace(/^https?:\/\//, ''))}</a>…</p>`
		: '';
	return `<!DOCTYPE html>
<html lang="${esc(lang)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">

<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:type" content="website">
<meta property="og:url" content="${esc(url)}">
<meta property="og:site_name" content="${esc(siteName)}">
<meta property="og:locale" content="${esc(locale)}">
${imageTag}

<meta name="twitter:card" content="${image ? 'summary_large_image' : 'summary'}">
<meta name="twitter:title" content="${esc(title)}">
<meta name="twitter:description" content="${esc(description)}">

${refreshTag}

<style>
body { font-family: system-ui, -apple-system, sans-serif; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; background: #0f172a; color: #e5e7eb; text-align: center; padding: 1rem; }
.card { max-width: 480px; }
h1 { font-size: 2rem; margin: 0 0 0.5rem; }
p { color: #94a3b8; line-height: 1.6; }
a { color: #6366f1; text-decoration: none; }
a:hover { text-decoration: underline; }
</style>
</head>
<body>
<div class="card">
<h1>${esc(glyph)} ${esc(title)}</h1>
<p>${esc(description)}</p>
${redirectLine}
</div>
</body>
</html>`;
}

/**
 * Convenience — build a full `Response` with sensible headers.
 *
 *   app.get('/', () => landingResponse({ title: 'Zap Prime', description: '...', url: env.PUBLIC_BASE_URL, redirectTo: 'https://propmind.co' }));
 */
export function landingResponse(opts: LandingHtmlOptions): Response {
	return new Response(landingHtml(opts), {
		headers: {
			'content-type': 'text/html; charset=utf-8',
			'cache-control': opts.cacheControl ?? 'public, max-age=3600',
		},
	});
}

function escapeHtml(s: string): string {
	return String(s)
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');
}
