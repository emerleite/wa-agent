#!/usr/bin/env bash
# Reverts the local Meta mock setup:
#   1. Kills mock-meta-server listening on $MOCK_META_PORT (default 4000)
#   2. Removes META_GRAPH_BASE_URL=http://localhost:$PORT line from .dev.vars
#
# `wrangler dev` hot-reloads (~2s) and the Worker resumes pointing at the
# real Meta API (default https://graph.facebook.com from wrangler.toml).
#
# USAGE
#   bash scripts/unmock-meta.sh

set -euo pipefail

PORT="${MOCK_META_PORT:-4000}"
ENV_FILE="${ENV_FILE:-.dev.vars}"
MOCK_LINE_REGEX="^META_GRAPH_BASE_URL=http://localhost:${PORT}\$"

# 1) Kill mock-meta-server if running
if lsof -ti:"$PORT" > /dev/null 2>&1; then
	PIDS=$(lsof -ti:"$PORT")
	echo "→ killing process(es) on :$PORT: $PIDS"
	echo "$PIDS" | xargs kill 2>/dev/null || true
	sleep 0.3
	if lsof -ti:"$PORT" > /dev/null 2>&1; then
		echo "⚠️  port $PORT still busy. Trying kill -9..."
		lsof -ti:"$PORT" | xargs kill -9 2>/dev/null || true
	fi
	echo "✅ port $PORT freed"
else
	echo "→ nothing running on :$PORT"
fi

# 2) Remove the line from .dev.vars
if [ ! -f "$ENV_FILE" ]; then
	echo "→ $ENV_FILE doesn't exist — nothing to revert."
	exit 0
fi

if grep -qE "$MOCK_LINE_REGEX" "$ENV_FILE"; then
	# BSD-compatible sed (macOS) — uses temporary .bak suffix
	sed -i.bak -E "/$MOCK_LINE_REGEX/d" "$ENV_FILE"
	rm -f "$ENV_FILE.bak"
	echo "✅ removed META_GRAPH_BASE_URL=http://localhost:$PORT from $ENV_FILE"
	echo "→ wrangler dev hot-reloads (~2s) back to real Meta API"
else
	echo "→ $ENV_FILE doesn't reference the mock — nothing to do."
fi
