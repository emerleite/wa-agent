/**
 * Drizzle Kit config — generates SQL migrations from src/db/schema/*.ts.
 *
 * From v0.2.0 onward, schema files in src/db/schema/ are the source of truth.
 * Run `npm run db:generate` to produce a new migration after editing them.
 * Pre-v0.2 migrations (`001_core.sql` … `010_channel_opt_outs.sql`) stay in
 * `migrations/` and are applied as-is to existing databases.
 */
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
	dialect: 'sqlite',
	schema: './src/db/schema/*.ts',
	out: './migrations',
	verbose: true,
	strict: true,
});
