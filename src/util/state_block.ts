/**
 * Format a "current state" block for injection into an LLM system prompt.
 *
 * Common pattern for form-fill agents (booking, lead capture, order intake):
 * on every turn, tell the model what has already been collected so it doesn't
 * re-ask. The block goes at the top of the system prompt as the source of
 * truth — the model is instructed to trust it over conversation history.
 *
 *   const state = formatStateBlock({
 *     label: 'BOOKING IN PROGRESS',
 *     fields: { day: '2026-08-01', time: null, party: 4 },
 *     labels: { day: 'Day', time: 'Time', party: 'Party size' },
 *     instructions: 'Do not re-ask any field already listed below.',
 *   });
 *   //
 *   // [BOOKING IN PROGRESS — Do not re-ask any field already listed below.]
 *   // - Day: 2026-08-01
 *   // - Party size: 4
 *
 * Empty / null / undefined values are skipped. If nothing renders, returns
 * an empty string so the caller can safely template it in unconditionally.
 */

export interface StateBlockOptions {
	label: string;
	fields: Record<string, unknown>;
	/** Pretty display name per field key. Missing keys fall back to the raw key. */
	labels?: Record<string, string>;
	/** Trailing instruction appended after the label. */
	instructions?: string;
	/** Custom value renderer. Default: booleans → "sim"/"não" is opinionated; use this to change. */
	formatValue?: (value: unknown, key: string) => string;
	/** Predicate: return true to skip. Default skips null / undefined / empty string / empty array. */
	skip?: (value: unknown, key: string) => boolean;
}

const defaultSkip = (v: unknown): boolean => v === null || v === undefined || v === '' || (Array.isArray(v) && v.length === 0);

const defaultFormatValue = (v: unknown): string => {
	if (typeof v === 'boolean') return v ? 'yes' : 'no';
	if (Array.isArray(v)) return v.map((x) => defaultFormatValue(x)).join(', ');
	return String(v);
};

export function formatStateBlock(opts: StateBlockOptions): string {
	const skip = opts.skip ?? defaultSkip;
	const fmt = opts.formatValue ?? defaultFormatValue;
	const labels = opts.labels ?? {};
	const lines: string[] = [];
	for (const [key, value] of Object.entries(opts.fields)) {
		if (skip(value, key)) continue;
		const label = labels[key] ?? key;
		lines.push(`- ${label}: ${fmt(value, key)}`);
	}
	if (lines.length === 0) return '';
	const header = opts.instructions ? `[${opts.label} — ${opts.instructions}]` : `[${opts.label}]`;
	return `${header}\n${lines.join('\n')}`;
}
