/**
 * Deterministic-hash holdout assignment.
 *
 * Decides whether `key` lands inside a `percentage`-sized cohort. Same key
 * + percentage + salt → same answer every call, so the assignment is
 * stable across deploys, isolates, and (with the same salt) across the
 * worker + downstream services.
 *
 * Typical uses:
 *
 *   - **ML A/B**: hold out 5% of users so their replies skip an ML score
 *     lookup. Comparing this cohort to the served cohort measures uplift
 *     without per-user feature flags. (psico's `agent/mode.ts`.)
 *   - **Gradual rollout**: ship a new pipeline to 10% of tenants first;
 *     raise the percentage day-by-day until reaching 100%.
 *   - **Synthetic-canary**: tag 1% of inbound webhook traces with extra
 *     logging when verifying a deploy.
 *
 * The split is at 1% resolution (SHA-256 → first 4 bytes → `% 100`), which
 * is fine for percentage-sized cohorts. If you need finer cohorts, mod by
 * 10_000 or higher — open an issue and we'll widen the API.
 *
 * Boundary semantics (strict `<` percentage):
 *
 *   - `percentage: 0`   → never in holdout
 *   - `percentage: 100` → always in holdout
 *
 * The function is async because `crypto.subtle.digest` is async.
 *
 * ## Salt for rotating cohorts
 *
 * Pass `salt` (e.g. an experiment id, a deploy date) to shift which keys
 * land in the holdout. Useful when you want a fresh draw without changing
 * the natural identifier (whatsapp, tenant id, etc.):
 *
 *   computeHoldout({ key: whatsapp, percentage: 5 })                   // stable forever
 *   computeHoldout({ key: whatsapp, percentage: 5, salt: 'exp-2026-q1' }) // rolls per experiment
 */

export interface ComputeHoldoutArgs {
	/** The natural identifier to assign on (whatsapp, tenant id, trace id…). */
	key: string;
	/** Cohort size as a percentage. Values outside [0, 100] are clamped. */
	percentage: number;
	/**
	 * Optional cohort-rotation salt. Mixed into the hash so two experiments
	 * over the same population draw independent samples.
	 */
	salt?: string;
}

const encoder = new TextEncoder();

/**
 * @returns `true` when `key` lands inside the `percentage`-sized cohort.
 */
export async function computeHoldout({ key, percentage, salt }: ComputeHoldoutArgs): Promise<boolean> {
	const pct = clamp(percentage, 0, 100);
	const input = salt ? `${salt}:${key}` : key;
	const buf = await crypto.subtle.digest('SHA-256', encoder.encode(input));
	const view = new DataView(buf);
	const n = view.getUint32(0, false) % 100;
	return n < pct;
}

function clamp(n: number, lo: number, hi: number): number {
	if (!Number.isFinite(n)) return lo;
	return Math.max(lo, Math.min(hi, n));
}
