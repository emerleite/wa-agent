/**
 * Structured `[PREFIX] scope: message` logger, grep-friendly for `wrangler tail`.
 *
 * Convention:
 *   [START]    entering a scope (route, cron, external call)
 *   [SUCCESS]  scope returned without error
 *   [FAIL]     scope threw or returned an error result
 *   [FINISH]   scope exited without a semantic outcome (`[SUCCESS]` and
 *              `[FAIL]` are mutually exclusive; `[FINISH]` is the umbrella
 *              you emit in `finally` when both terminal states are noisy)
 *   [INFO]     mid-scope breadcrumbs
 *
 * All emit through `console.log` (Cloudflare Workers pipes stdout to tail).
 * `[FAIL]` also stashes the caller-supplied error via `console.error` for
 * source-map-friendly stack traces in the dashboard.
 */

type Extra = Record<string, unknown> | undefined;

function fmt(scope: string, message: string | undefined, extra: Extra): string {
	const parts = [scope];
	if (message) parts.push(message);
	if (extra && Object.keys(extra).length) parts.push(JSON.stringify(extra));
	return parts.join(' ');
}

export const log = {
	start(scope: string, message?: string, extra?: Extra): void {
		console.log(`[START] ${fmt(scope, message, extra)}`);
	},
	success(scope: string, message?: string, extra?: Extra): void {
		console.log(`[SUCCESS] ${fmt(scope, message, extra)}`);
	},
	fail(scope: string, message?: string, error?: unknown, extra?: Extra): void {
		console.log(`[FAIL] ${fmt(scope, message, extra)}`);
		if (error !== undefined) console.error(error);
	},
	finish(scope: string, message?: string, extra?: Extra): void {
		console.log(`[FINISH] ${fmt(scope, message, extra)}`);
	},
	info(scope: string, message?: string, extra?: Extra): void {
		console.log(`[INFO] ${fmt(scope, message, extra)}`);
	},
};

export type Log = typeof log;
