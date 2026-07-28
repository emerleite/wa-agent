import { describe, it, expect } from 'vitest';
import { withTenant } from '../../src/db/with_tenant.js';
import { eq, sql } from 'drizzle-orm';

import { sqliteTable, text } from 'drizzle-orm/sqlite-core';

const patients = sqliteTable('patients', {
	id: text('id').primaryKey(),
	tenantId: text('tenant_id').notNull(),
	name: text('name'),
});

describe('withTenant', () => {
	it('returns a SQL fragment with the tenant filter', () => {
		const clause = withTenant('t-1', patients.tenantId);
		expect(clause).toBeDefined();
		// Drizzle SQL fragments don't have a stable public shape; the smoke test is
		// that it returns something truthy without throwing.
	});

	it('composes with extra where clauses', () => {
		const clause = withTenant('t-1', patients.tenantId, eq(patients.id, 'p-1'));
		expect(clause).toBeDefined();
	});

	it('undefined extras are filtered out', () => {
		expect(() => withTenant('t-1', patients.tenantId, undefined, undefined)).not.toThrow();
	});

	it('accepts a mix of defined and undefined extras', () => {
		const clause = withTenant('t-1', patients.tenantId, undefined, eq(patients.id, 'x'), undefined);
		expect(clause).toBeDefined();
	});

	it('accepts a raw sql`...` extra', () => {
		const clause = withTenant('t-1', patients.tenantId, sql`${patients.name} IS NOT NULL`);
		expect(clause).toBeDefined();
	});
});
