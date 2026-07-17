#!/usr/bin/env bash
# Reads secrets from .dev.vars and pushes each via `wrangler secret put`.
# Skips blank lines, comments, and vars not in the SECRETS list.
#
# USAGE
#   bash scripts/push-secrets.sh                 # → default env (workers.dev)
#   bash scripts/push-secrets.sh staging         # → --env staging
#   bash scripts/push-secrets.sh production      # → --env production
#
# Dry-run (lists what would be pushed, doesn't actually push):
#   DRY=1 bash scripts/push-secrets.sh
#
# Customize which keys are pushed:
#   SECRETS_FILE=./my-secrets.list bash scripts/push-secrets.sh
#     (one secret name per line; lines starting with # are comments)
#
# Default list — the common Meta + AI provider envelope. Edit in-file or
# override via SECRETS_FILE for app-specific needs.

set -euo pipefail

ENV_NAME="${1:-}"
ENV_FLAG=""
[ -n "$ENV_NAME" ] && ENV_FLAG="--env $ENV_NAME"

ENV_FILE=".dev.vars"
[ ! -f "$ENV_FILE" ] && { echo "ERROR: $ENV_FILE does not exist"; exit 1; }

# Default secret list. Override via SECRETS_FILE for custom keys.
DEFAULT_SECRETS=(
	META_ACCESS_TOKEN
	META_APP_SECRET
	META_WEBHOOK_VERIFY_TOKEN
	META_PHONE_NUMBER_ID
	META_WABA_ID
	META_APP_ID
	OPENAI_API_KEY
	ANTHROPIC_API_KEY
	GROQ_API_KEY
	GEMINI_API_KEY
)

if [ -n "${SECRETS_FILE:-}" ]; then
	[ ! -f "$SECRETS_FILE" ] && { echo "ERROR: SECRETS_FILE='$SECRETS_FILE' not found"; exit 1; }
	mapfile -t SECRETS < <(grep -vE '^\s*(#|$)' "$SECRETS_FILE")
else
	SECRETS=("${DEFAULT_SECRETS[@]}")
fi

echo "→ target: ${ENV_NAME:-default} ${ENV_FLAG}"
echo "→ secrets: ${#SECRETS[@]}"
echo

for SECRET in "${SECRETS[@]}"; do
	VALUE=$(grep -E "^${SECRET}=" "$ENV_FILE" 2>/dev/null | head -1 | cut -d= -f2-)
	if [ -z "$VALUE" ]; then
		echo "⏭  $SECRET — empty in $ENV_FILE, skipping"
		continue
	fi
	if [ "${DRY:-0}" = "1" ]; then
		echo "🟡 [DRY] $SECRET = ${VALUE:0:8}..."
		continue
	fi
	echo "→ pushing $SECRET..."
	if printf '%s' "$VALUE" | npx wrangler secret put "$SECRET" $ENV_FLAG > /dev/null 2>&1; then
		echo "   ✅ $SECRET ok"
	else
		echo "   ❌ $SECRET failed"
	fi
done

echo
echo "✅ done"
