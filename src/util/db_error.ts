/**
 * D1 / SQLite error taxonomy — used to write greppable log lines without
 * changing the fail-open / fail-closed semantics of each store method.
 *
 *   } catch (e) {
 *     const kind = classifyDbError(e);
 *     console.log(`[LeadStore] method=optIn kind=${kind} msg=${(e as Error).message}`);
 *     if (kind === 'schema' && (e as Error).stack) console.log((e as Error).stack);
 *     return false; // keep whatever fallback semantics you had
 *   }
 *
 * The `schema` bucket is the one worth screaming about — those are real
 * migration-drift bugs that would otherwise silently degrade the experience.
 * `transient` is expected occasionally under load; `unknown` is either a new
 * failure mode or something the taxonomy doesn't cover yet.
 *
 * Extracted from bibliafala's `src/lead.js:classifyDbError`.
 */

export type DbErrorKind = 'schema' | 'transient' | 'unknown';

/** Classify a D1 / SQLite error message into a coarse taxonomy. Never throws. */
export function classifyDbError(e: unknown): DbErrorKind {
	const msg = String((e as { message?: unknown })?.message || e || '').toLowerCase();

	if (
		msg.includes('no such column') ||
		msg.includes('no such table') ||
		msg.includes('sqlite_cantopen') ||
		msg.includes('sqlite_corrupt') ||
		msg.includes('has no column') ||
		msg.includes('constraint failed')
	) {
		return 'schema';
	}

	if (
		msg.includes('timeout') ||
		msg.includes('connection') ||
		msg.includes('object was reset') ||
		msg.includes('storage operation') ||
		msg.includes('service unavailable') ||
		msg.includes('too many')
	) {
		return 'transient';
	}

	return 'unknown';
}

/**
 * Convenience one-liner: classify + emit a `[Scope] method=X kind=Y msg=Z`
 * log line. Also dumps the stack when `kind === 'schema'` because those are
 * bugs, not blips.
 *
 *   logDbError('LeadStore', 'optIn', err);
 */
export function logDbError(scope: string, method: string, e: unknown): DbErrorKind {
	const kind = classifyDbError(e);
	const asErr = e as { message?: unknown; stack?: unknown };
	console.log(`[${scope}] method=${method} kind=${kind} msg=${String(asErr?.message ?? e)}`);
	if (kind === 'schema' && typeof asErr?.stack === 'string') console.log(asErr.stack);
	return kind;
}
