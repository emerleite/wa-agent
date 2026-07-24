#!/usr/bin/env node
/**
 * wa-agent CLI — currently one subcommand: `init`.
 *
 * Usage:
 *   npx wa-agent init [dir] [--template=echo-bot|tool-agent|support-bot|multi-tenant-bot]
 *   npx wa-agent --help
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = resolve(__dirname, '..');

const TEMPLATES = ['echo-bot', 'tool-agent', 'support-bot', 'multi-tenant-bot', 'full-bot'];
const DEFAULT_TEMPLATE = 'echo-bot';

async function main() {
	const [subcommand, ...rest] = process.argv.slice(2);

	if (!subcommand || subcommand === '--help' || subcommand === '-h') {
		printHelp();
		process.exit(subcommand ? 0 : 1);
	}

	if (subcommand === 'init') {
		return init(rest);
	}

	console.error(`Unknown subcommand: ${subcommand}`);
	printHelp();
	process.exit(1);
}

function printHelp() {
	console.log(`wa-agent — CLI

Usage:
  npx wa-agent init [dir] [--template=<name>]     scaffold a new bot

Templates:
  ${TEMPLATES.map((t) => (t === DEFAULT_TEMPLATE ? `${t} (default)` : t)).join('\n  ')}

Examples:
  npx wa-agent init my-bot
  npx wa-agent init my-support --template=support-bot
`);
}

async function init(args) {
	const flags = {};
	const positional = [];
	for (const a of args) {
		if (a.startsWith('--')) {
			const [k, v] = a.slice(2).split('=');
			flags[k] = v ?? true;
		} else {
			positional.push(a);
		}
	}

	const template = String(flags.template || DEFAULT_TEMPLATE);
	if (!TEMPLATES.includes(template)) {
		console.error(`Unknown template: ${template}`);
		console.error(`Available: ${TEMPLATES.join(', ')}`);
		process.exit(1);
	}

	let target = positional[0];
	if (!target) {
		const rl = createInterface({ input, output });
		target = (await rl.question('Project directory: ')).trim();
		rl.close();
	}
	if (!target) {
		console.error('No directory given.');
		process.exit(1);
	}

	const outDir = resolve(process.cwd(), target);
	const projectName = basename(outDir);

	if (existsSync(outDir) && readdirSync(outDir).length > 0) {
		console.error(`Directory ${target} exists and is not empty.`);
		process.exit(1);
	}
	mkdirSync(outDir, { recursive: true });

	const templateDir = join(PKG_ROOT, 'examples', template);
	if (!existsSync(templateDir)) {
		console.error(`Template not found on disk: ${templateDir}`);
		console.error('This CLI must be run from an installed wa-agent (npx wa-agent init ...).');
		process.exit(1);
	}

	// Files to skip when copying a template.
	const skip = new Set(['.dev.vars', 'node_modules', '.wrangler', 'dist']);

	copyTree(templateDir, outDir, skip, (filePath) => transform(filePath, { projectName, template }));

	// Ensure .gitignore exists.
	const gitignore = join(outDir, '.gitignore');
	if (!existsSync(gitignore)) {
		writeFileSync(gitignore, defaultGitignore());
	}

	printNextSteps({ target, template });
}

function copyTree(srcDir, dstDir, skip, transform) {
	for (const entry of readdirSync(srcDir)) {
		if (skip.has(entry)) continue;
		const s = join(srcDir, entry);
		const d = join(dstDir, entry);
		const st = statSync(s);
		if (st.isDirectory()) {
			mkdirSync(d, { recursive: true });
			copyTree(s, d, skip, transform);
		} else {
			const raw = readFileSync(s);
			const out = transform ? transform({ src: s, name: entry, contents: raw }) : raw;
			writeFileSync(d, out);
		}
	}
}

function transform({ name, contents }, { projectName, template }) {
	const waVersion = readWaVersion();

	// Applied to every text file: rewrite intra-repo paths and template-name references
	// so the scaffolded project stands alone.
	const rewriteText = (input) =>
		input
			.replaceAll('../../migrations', 'node_modules/wa-agent/migrations')
			.replaceAll('../../tools/mock-meta-server.ts', 'node_modules/wa-agent/tools/mock-meta-server.ts')
			.replaceAll(new RegExp(`\\b${escapeRegex(template)}\\b`, 'g'), projectName);

	if (name === 'package.json') {
		const pkg = JSON.parse(contents.toString('utf8'));
		if (pkg.dependencies?.['wa-agent']?.startsWith('file:')) {
			pkg.dependencies['wa-agent'] = `^${waVersion}`;
		}
		pkg.name = projectName;
		pkg.description = pkg.description || 'wa-agent bot';
		if (pkg.scripts) {
			for (const [k, v] of Object.entries(pkg.scripts)) {
				if (typeof v === 'string') pkg.scripts[k] = rewriteText(v);
			}
		}
		return Buffer.from(JSON.stringify(pkg, null, '\t') + '\n');
	}

	if (name === 'wrangler.toml' || name === 'README.md' || name === '.dev.vars.example') {
		return Buffer.from(rewriteText(contents.toString('utf8')));
	}

	return contents;
}

function escapeRegex(s) {
	return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function readWaVersion() {
	try {
		const pkg = JSON.parse(readFileSync(join(PKG_ROOT, 'package.json'), 'utf8'));
		return pkg.version || '0.11.1';
	} catch {
		return '0.11.1';
	}
}

function defaultGitignore() {
	return [
		'node_modules',
		'.dev.vars',
		'.wrangler',
		'dist',
		'coverage',
		'.DS_Store',
		'',
	].join('\n');
}

function printNextSteps({ target, template }) {
	console.log(`
✔ Scaffolded ${template} at ${target}/

Next:
  cd ${target}
  cp .dev.vars.example .dev.vars       # then fill in Meta secrets
  npm install
  npm run db:create                     # → paste the printed database_id into wrangler.toml
  npm run db:migrate                    # apply framework migrations to local D1

  # local dev without real Meta:
  npm run mock:meta                     # (separate terminal — fake graph.facebook.com)
  # add META_GRAPH_BASE_URL=http://localhost:4000 to .dev.vars, then:
  npm run dev

See ${target}/README.md for the full walkthrough.
`);
}

main().catch((err) => {
	console.error(err.stack || err.message || String(err));
	process.exit(1);
});
