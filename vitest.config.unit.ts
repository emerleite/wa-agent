/**
 * Vitest config for **unit tests only** — runs in the default Node pool with
 * no Workers runtime.
 *
 * Used by Stryker (mutation testing) because the Workers pool re-spawns workerd
 * processes per mutant, which is too slow. Stryker only mutates files
 * exercised by these unit tests.
 */
import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		globals: true,
		include: ['test/unit/**/*.test.ts'],
		exclude: ['test/integration/**', 'test/e2e/**'],
	},
});
