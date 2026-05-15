/**
 * Append UTM tracking params to an outbound URL.
 *
 * Preserves an existing `#anchor` fragment and existing query string, so a
 * value like `https://app.com/x?ref=abc#sec` stays well-formed after tagging.
 *
 *   withUtm('https://x.com/a?ref=abc#sec', { source: 'whatsapp', campaign: 'devo' })
 *     → 'https://x.com/a?ref=abc&utm_source=whatsapp&utm_medium=chat&utm_campaign=devo#sec'
 *
 * Defaults: medium = 'chat' (this is a chat-channel framework). Source has no
 * default — it's the identifier that downstream analytics group by, so the
 * caller must specify it.
 *
 * `createUtmTagger` returns a partially-applied tagger when the source/medium
 * stay constant across calls (the usual case for a single bot):
 *
 *   const tagWa = createUtmTagger({ source: 'whatsapp' });
 *   tagWa('https://x.com/a', 'devo') // → '...utm_source=whatsapp&utm_medium=chat&utm_campaign=devo'
 */

export interface UtmParams {
	source: string;
	campaign: string;
	medium?: string;
	term?: string;
	content?: string;
}

export function withUtm(url: string, params: UtmParams): string {
	const { source, campaign, medium = 'chat', term, content } = params;
	if (!source) throw new Error('withUtm: source required');
	if (!campaign) throw new Error('withUtm: campaign required');

	const parts = [
		`utm_source=${encodeURIComponent(source)}`,
		`utm_medium=${encodeURIComponent(medium)}`,
		`utm_campaign=${encodeURIComponent(campaign)}`,
	];
	if (term) parts.push(`utm_term=${encodeURIComponent(term)}`);
	if (content) parts.push(`utm_content=${encodeURIComponent(content)}`);
	const utm = parts.join('&');

	const hashIdx = url.indexOf('#');
	const hash = hashIdx >= 0 ? url.slice(hashIdx) : '';
	const path = hashIdx >= 0 ? url.slice(0, hashIdx) : url;
	const sep = path.includes('?') ? '&' : '?';
	return `${path}${sep}${utm}${hash}`;
}

export interface UtmTaggerDefaults {
	source: string;
	medium?: string;
	term?: string;
	content?: string;
}

export type UtmTagger = (url: string, campaign: string, overrides?: Partial<UtmParams>) => string;

export function createUtmTagger(defaults: UtmTaggerDefaults): UtmTagger {
	if (!defaults?.source) throw new Error('createUtmTagger: defaults.source required');
	return (url, campaign, overrides) =>
		withUtm(url, {
			source: defaults.source,
			medium: defaults.medium,
			term: defaults.term,
			content: defaults.content,
			...overrides,
			campaign,
		});
}
