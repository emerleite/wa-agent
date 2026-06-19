/**
 * Drizzle client factory for wa-agent.
 *
 * From v0.2.0 onward, framework stores use Drizzle. Construct the client
 * once at the worker boundary and pass it (or let `Agent` construct it from
 * `env.DB`):
 *
 *   const db = createDb(env.DB)
 *   const leads = new LeadStore({ db })
 *
 * `Agent` accepts `db: D1Database | DB` and constructs the Drizzle client
 * internally; the resulting client is exposed as `agent.db`.
 */
import { drizzle, type DrizzleD1Database } from 'drizzle-orm/d1';
import * as schema from './schema/index.js';

export type Schema = typeof schema;
export type DB = DrizzleD1Database<Schema>;

export function createDb(d1: D1Database): DB {
	return drizzle(d1, { schema, logger: false });
}

/** Distinguishes a Drizzle client from a raw `D1Database` at construction time. */
export function isDrizzleClient(db: D1Database | DB): db is DB {
	return typeof (db as { _?: unknown })._ === 'object' && (db as { _?: unknown })._ !== null;
}

/**
 * Accept either a raw `D1Database` binding or an already-built Drizzle
 * client; return the framework's Drizzle client. Eliminates the friction
 * that surfaced in the psico v0.6 back-migration where downstream apps
 * with their own Drizzle clients (typed against their own schemas) couldn't
 * pass them to framework stores without wrapping `createDb(env.DB)` first.
 *
 * The framework client is constructed against `wa-agent`'s schema. If the
 * caller passes a foreign Drizzle client (e.g. `createDB(env.DB)` from a
 * sister package), `normalizeDb` reaches into its underlying `$client`
 * (the raw `D1Database`) and rebuilds against our schema. App-table stores
 * (`EscalationStore`, `ConsentStore`, `ContentGenerator`, `HybridSearch`)
 * only use the client for raw `sql\`...\`` queries — they never read or
 * write the framework's typed tables through it, so this rebind is safe.
 */
export function normalizeDb(db: D1Database | DB): DB {
	if (isDrizzleClient(db)) {
		const underlying = (db as unknown as { $client?: D1Database }).$client;
		if (underlying) return createDb(underlying);
		// $client isn't reachable (older drizzle build, custom wrapper). Return
		// the client as-is; raw-SQL queries don't depend on the schema binding.
		return db;
	}
	return createDb(db);
}

export { schema };
