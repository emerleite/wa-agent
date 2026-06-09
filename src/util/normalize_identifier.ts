/**
 * Normalize an arbitrary user / LLM string into a stable SCREAMING_SNAKE
 * identifier, optionally resolving against a known-values map.
 *
 * The pipeline: strip diacritics → uppercase → collapse spaces and dashes
 * to `_` → drop everything outside `[A-Z_]` → squash runs of `_` → trim
 * leading/trailing `_`.
 *
 *   normalizeIdentifier('Ajuste de Refeição')       // 'AJUSTE_DE_REFEICAO'
 *   normalizeIdentifier('código-de-barras')         // 'CODIGO_DE_BARRAS'
 *   normalizeIdentifier('  AJUSTE_DE_REFEICAO  ')   // 'AJUSTE_DE_REFEICAO'
 *
 * With a `map`, resolves the normalized form to an enum value (or null):
 *
 *   const map = { AJUSTE_DE_REFEICAO: 'meal_adjust', OUTRO: 'other' };
 *   normalizeIdentifier('Ajuste de Refeição', { map })  // 'meal_adjust'
 *   normalizeIdentifier('???', { map })                  // null
 *
 * Use `fallback` to return a default instead of null on miss:
 *
 *   normalizeIdentifier('???', { map, fallback: 'other' })  // 'other'
 *
 * Why this exists: aysu had two near-identical copies of this pipeline —
 * one for image-category routing (`util/category.ts:39`) and one for
 * text-classification (`ai/classifier.ts:37`). Writing it twice in one
 * project is the signal it should be framework material.
 */

const DIACRITIC_RE = /[̀-ͯ]/g;

export interface NormalizeIdentifierOptions<T = string> {
	/** Known-values map applied after normalization. */
	map?: Record<string, T>;
	/** Value returned when `map` is set and the normalized form is not in it. */
	fallback?: T;
}

/**
 * Normalize without a map: returns the SCREAMING_SNAKE form, or `''` when
 * the input collapses to empty (`null`, `undefined`, pure punctuation,
 * etc.).
 */
export function normalizeIdentifier(raw: string | null | undefined): string;

/**
 * Normalize and resolve against a `map`, with a `fallback` that's always
 * returned on miss. Return type is `T` (never null) because `fallback` is
 * non-nullable here.
 */
export function normalizeIdentifier<T>(
	raw: string | null | undefined,
	options: { map: Record<string, T>; fallback: T },
): T;

/**
 * Normalize and resolve against a `map` with no fallback. Returns the
 * mapped value or `null` on miss.
 */
export function normalizeIdentifier<T>(
	raw: string | null | undefined,
	options: { map: Record<string, T>; fallback?: undefined },
): T | null;

export function normalizeIdentifier<T = string>(
	raw: string | null | undefined,
	options: NormalizeIdentifierOptions<T> = {},
): string | T | null {
	const flattened = normalize(raw);
	if (!options.map) return flattened;
	if (!flattened) return options.fallback ?? null;
	const hit = options.map[flattened];
	if (hit !== undefined) return hit;
	return options.fallback ?? null;
}

function normalize(raw: string | null | undefined): string {
	if (raw === null || raw === undefined) return '';
	return String(raw)
		.normalize('NFD')
		.replace(DIACRITIC_RE, '')
		.toUpperCase()
		.replace(/[\s\-]+/g, '_')
		.replace(/[^A-Z_]/g, '')
		.replace(/_+/g, '_')
		.replace(/^_|_$/g, '');
}
