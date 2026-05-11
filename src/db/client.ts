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

export { schema };
