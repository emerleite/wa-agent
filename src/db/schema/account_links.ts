/**
 * Account linking — short-lived redeem codes + long-lived identity → whatsapp map.
 *
 * Schema mirrors migrations/012_account_links.sql.
 */
import { sqliteTable, integer, text, index, unique } from 'drizzle-orm/sqlite-core';

export const accountLinkCodes = sqliteTable(
	'account_link_codes',
	{
		id: integer('id').primaryKey({ autoIncrement: true }),
		codeHash: text('code_hash').notNull().unique(),
		identityKind: text('identity_kind').notNull(),
		identityValue: text('identity_value').notNull(),
		createdAt: integer('created_at').notNull(),
		expiresAt: integer('expires_at').notNull(),
		usedAt: integer('used_at'),
		usedByWhatsapp: text('used_by_whatsapp'),
	},
	(t) => [
		index('idx_account_link_codes_expires').on(t.expiresAt),
		index('idx_account_link_codes_identity').on(t.identityKind, t.identityValue),
	]
);

export const accountLinks = sqliteTable(
	'account_links',
	{
		id: integer('id').primaryKey({ autoIncrement: true }),
		whatsapp: text('whatsapp').notNull(),
		identityKind: text('identity_kind').notNull(),
		identityValue: text('identity_value').notNull(),
		linkedAt: integer('linked_at').notNull(),
		lastSeenAt: integer('last_seen_at').notNull(),
	},
	(t) => [
		unique('account_links_identity_uq').on(t.identityKind, t.identityValue),
		index('idx_account_links_whatsapp').on(t.whatsapp),
	]
);

export type AccountLinkCodeRow = typeof accountLinkCodes.$inferSelect;
export type AccountLinkRow = typeof accountLinks.$inferSelect;
