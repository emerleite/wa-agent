/**
 * User profiles + opt-in / funnel state.
 *
 * Schema mirrors migrations/002_users.sql.
 */
import { sqliteTable, integer, text, index } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';

export const leads = sqliteTable(
	'leads',
	{
		id: integer('id').primaryKey({ autoIncrement: true }),
		ctwaClid: text('ctwa_clid'),
		whatsapp: text('whatsapp').unique().notNull(),
		adData: text('ad_data').notNull().default('{}'),
		createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
		funnelState: text('funnel_state').notNull().default('NEW'),
		optIn: integer('opt_in').notNull().default(0),
		optInDate: text('opt_in_date'),
		optOutDate: text('opt_out_date'),
	},
	(t) => [
		index('idx_leads_created_at').on(t.createdAt),
		index('idx_leads_funnel_state').on(t.funnelState),
		index('idx_leads_whatsapp_opt_in').on(t.whatsapp, t.optIn),
	]
);

export type Lead = typeof leads.$inferSelect;
export type NewLead = typeof leads.$inferInsert;
