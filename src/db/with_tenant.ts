/**
 * Drizzle helper for multi-tenant row-level enforcement (v0.17).
 *
 * Compose it into every SELECT / UPDATE / DELETE clause that touches a
 * table with a `tenant_id` column. Missing the guard = potential
 * cross-tenant read. Right for consumers who want a lint-checkable
 * "always call withTenant on tenant-scoped queries" rule.
 *
 *   const rows = await db
 *     .select()
 *     .from(patients)
 *     .where(withTenant(tenantId, patients.tenantId, eq(patients.id, x)));
 *
 * Extracted from psico's `packages/db/src/helpers/with-tenant.ts`.
 * Framework-owned so consumers don't reinvent (and so wa-agent's own
 * multi-tenant stores can adopt it internally in future refactors).
 */
import { and, eq, type SQL } from 'drizzle-orm';
import type { SQLiteColumn } from 'drizzle-orm/sqlite-core';

/**
 * Build a `WHERE tenant_id = ? [AND ...extra]` SQL fragment.
 *
 * Throws when no filters end up non-undefined (protects against an
 * accidental call with only undefined extras).
 */
export function withTenant(
	tenantId: string,
	tenantColumn: SQLiteColumn,
	...extraWhere: (SQL | undefined)[]
): SQL {
	const filters = [eq(tenantColumn, tenantId), ...extraWhere].filter(Boolean) as SQL[];
	const result = and(...filters);
	if (!result) throw new Error('withTenant: requires at least the tenant_id filter');
	return result;
}
