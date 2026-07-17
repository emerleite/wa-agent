#!/usr/bin/env bash
# Fails the build if values that should come from env vars are detected
# inlined in source code. Run in CI before `wrangler deploy`.
#
# USAGE
#   bash scripts/check-hardcoded.sh                # default: scan ./src
#   ROOT=examples/full-bot/src bash scripts/check-hardcoded.sh
#
# Customize the regex:
#   HARDCODED_PATTERNS='custom-regex' bash scripts/check-hardcoded.sh
#     # fully replaces the default
#
#   HARDCODED_EXTRA_PATTERNS='|gpt-[0-9]|claude-[0-9]' bash scripts/check-hardcoded.sh
#     # appends to the default (note the leading pipe)
#
# Skip specific files (default skips env.ts):
#   EXCLUDE_GLOB='env.ts|config.ts' bash scripts/check-hardcoded.sh
#
# JSDoc/multi-line comment lines (starting with `*`) and single-line `//`
# comments are auto-skipped — documentation often legitimately mentions URLs
# and model names. Only "live" code is checked.
#
# Per-line escape hatch: append `// hardcoded:allow` to a line to whitelist it.
# Use sparingly — prefer moving the value to env. Reserved for framework
# defaults that genuinely have nowhere else to live.
#
# Exit codes:
#   0  no matches → ok
#   1  matches found → caller should fail the build
#   2  invocation error (missing root, etc.)

set -e

ROOT="${ROOT:-src}"
EXCLUDE_GLOB="${EXCLUDE_GLOB:-env.ts}"

# Default patterns — external service URLs that should always come from env.
# LLM model slugs are intentionally NOT default (framework code often has
# legitimate defaults). Opt in via HARDCODED_EXTRA_PATTERNS if you want them.
DEFAULT_PATTERNS='https?://(graph\.facebook|[a-z0-9.-]+\.workers\.dev|api\.openai\.com|api\.anthropic\.com|generativelanguage\.googleapis\.com|[a-z]+\.cloud\.langfuse\.com|api\.groq\.com)'
PATTERNS="${HARDCODED_PATTERNS:-$DEFAULT_PATTERNS}${HARDCODED_EXTRA_PATTERNS:-}"

if [ ! -d "$ROOT" ]; then
	echo "❌ check-hardcoded: ROOT directory '$ROOT' does not exist."
	exit 2
fi

# Build --exclude args from EXCLUDE_GLOB (pipe-separated → repeated flags)
EXCLUDE_FLAGS=()
IFS='|' read -ra EXCLUDES <<< "$EXCLUDE_GLOB"
for pat in "${EXCLUDES[@]}"; do
	EXCLUDE_FLAGS+=("--exclude=$pat")
done

# 1) Match hardcoded patterns
# 2) Strip JSDoc lines whose content begins with `*` or `/**`
# 3) Strip lines whose content begins with `//` (single-line comments)
# 4) Strip lines containing the escape hatch `// hardcoded:allow`
# Anchor to the position AFTER `file:lineno:` so we only look at line content.
RAW_HITS=$(grep -rEn "$PATTERNS" "$ROOT" --include='*.ts' "${EXCLUDE_FLAGS[@]}" 2>/dev/null || true)
HITS=$(printf '%s\n' "$RAW_HITS" \
	| grep -vE '^[^:]+:[0-9]+:[[:space:]]*(\*|/\*\*|//)' \
	| grep -vF 'hardcoded:allow' \
	|| true)

if [ -n "$HITS" ]; then
	echo "$HITS"
	echo ""
	echo "❌ Hardcoded value detected in $ROOT/."
	echo "   Move it to env (wrangler.toml [vars] or 'wrangler secret put')."
	echo "   To allow specific files, set EXCLUDE_GLOB='env.ts|other.ts'."
	echo "   To override the regex, set HARDCODED_PATTERNS='...'."
	exit 1
fi

echo "✅ check-hardcoded passed ($ROOT)"
