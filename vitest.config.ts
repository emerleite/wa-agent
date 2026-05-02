import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineWorkersProject, readD1Migrations } from '@cloudflare/vitest-pool-workers/config';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineWorkersProject(async () => {
	const migrations = await readD1Migrations(path.join(__dirname, 'migrations'));
	return {
		test: {
			globals: true,
			setupFiles: ['./test/setup.ts'],
			coverage: {
				provider: 'istanbul',
				reporter: ['text', 'html', 'json-summary'],
				include: ['src/**/*.ts'],
				exclude: ['src/**/*.d.ts', 'src/types.ts', 'src/cloudflare.d.ts'],
				thresholds: {
					// Floor at current measured coverage so regressions break CI.
					// Modules below the floor: search SQL methods, a few
					// WhatsAppClient methods (sendContact, sendTemplate, downloadMedia).
					lines: 70,
					functions: 60,
					statements: 65,
					branches: 55,
				},
				reportsDirectory: './coverage',
			},
			poolOptions: {
				workers: {
					singleWorker: true,
					miniflare: {
						compatibilityFlags: ['nodejs_compat'],
						compatibilityDate: '2024-12-30',
						d1Databases: ['DB'],
						bindings: { TEST_MIGRATIONS: migrations },
					},
				},
			},
		},
	};
});
