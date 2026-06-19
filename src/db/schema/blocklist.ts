/**
 * Per-number abuse blocklist.
 *
 * v0.8: composite primary key on (whatsapp, tenant_id). Single-tenant
 * deployments get `tenant_id = ''` (empty string) so the constraint
 * behaves identically to the old whatsapp-PK shape. Multi-tenant
 * deployments pass a real tenantId on the Blocklist constructor.
 *
 * Schema mirrors migrations/011_blocklist.sql + 017_blocklist_tenant.sql.
 */
import { sqliteTable, text, index, primaryKey } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';

export const blockedNumbers = sqliteTable(
	'blocked_numbers',
	{
		whatsapp: text('whatsapp').notNull(),
		tenantId: text('tenant_id').notNull().default(''),
		reason: text('reason').notNull(),
		blockedAt: text('blocked_at').notNull().default(sql`(datetime('now'))`),
		blockedBy: text('blocked_by'),
		expiresAt: text('expires_at'),
		notes: text('notes'),
	},
	(t) => [
		primaryKey({ columns: [t.whatsapp, t.tenantId] }),
		index('idx_blocked_expires').on(t.expiresAt),
		index('idx_blocked_tenant').on(t.tenantId, t.expiresAt),
	]
);

export type BlockedNumberRow = typeof blockedNumbers.$inferSelect;
