#!/usr/bin/env bash
# Manage Meta App webhook URL and WABA→App subscription.
#
# There are TWO independent concepts:
#  - WEBHOOK URL on the App (varies per env, e.g. changes when local tunnel
#    rotates) → cmd `set-url`
#  - WABA subscription on the App (1× per WABA, rarely changes) → cmd `subscribe`
# Both must be green for events to flow. See docs/META_SETUP.md for the model.
#
# USAGE
#   bash scripts/meta-webhook.sh status                            # apps subscribed to WABA
#   bash scripts/meta-webhook.sh subscribe                         # subscribe app to WABA (1×)
#   bash scripts/meta-webhook.sh unsubscribe                       # undo subscribe
#   bash scripts/meta-webhook.sh url-status                        # current callback_url + fields
#   bash scripts/meta-webhook.sh set-url <https://.../webhook>     # set URL + verify_token + fields
#   bash scripts/meta-webhook.sh set-url-local <tunnel-base-url>   # appends /meta/whatsapp/webhook
#
# Reads .dev.vars (development) by default. For other envs:
#   ENV_FILE=.dev.vars.staging bash scripts/meta-webhook.sh ...
#
# Required env vars (all):
#   META_ACCESS_TOKEN, META_WABA_ID
# Additionally for set-url:
#   META_APP_ID, META_APP_SECRET, META_WEBHOOK_VERIFY_TOKEN
#
# Optional overrides:
#   META_GRAPH_BASE_URL          default https://graph.facebook.com
#   META_GRAPH_API_VERSION       default v22.0
#   META_WEBHOOK_FIELDS          default messages,message_template_status_update
#   META_WEBHOOK_PATH            default /meta/whatsapp/webhook (used by set-url-local)

set -euo pipefail

ENV_FILE="${ENV_FILE:-.dev.vars}"
if [ -f "$ENV_FILE" ]; then
	set -a
	# shellcheck disable=SC1090
	source "$ENV_FILE"
	set +a
fi

META_GRAPH_BASE_URL="${META_GRAPH_BASE_URL:-https://graph.facebook.com}"
META_GRAPH_API_VERSION="${META_GRAPH_API_VERSION:-v22.0}"
META_WEBHOOK_FIELDS="${META_WEBHOOK_FIELDS:-messages,message_template_status_update}"
META_WEBHOOK_PATH="${META_WEBHOOK_PATH:-/meta/whatsapp/webhook}"

: "${META_ACCESS_TOKEN:?ERROR: META_ACCESS_TOKEN not set in $ENV_FILE}"
: "${META_WABA_ID:?ERROR: META_WABA_ID not set in $ENV_FILE}"

CMD="${1:-help}"

# ---------------- WABA subscription (1×) ----------------

cmd_status() {
	echo "→ Apps subscribed to WABA ${META_WABA_ID}:"
	curl -s -H "Authorization: Bearer $META_ACCESS_TOKEN" \
		"${META_GRAPH_BASE_URL}/${META_GRAPH_API_VERSION}/${META_WABA_ID}/subscribed_apps" | jq
}

cmd_subscribe() {
	echo "→ Subscribing app to WABA ${META_WABA_ID}..."
	curl -s -X POST -H "Authorization: Bearer $META_ACCESS_TOKEN" \
		"${META_GRAPH_BASE_URL}/${META_GRAPH_API_VERSION}/${META_WABA_ID}/subscribed_apps" | jq
	echo
	echo "Validating:"
	cmd_status
}

cmd_unsubscribe() {
	echo "→ Unsubscribing app from WABA ${META_WABA_ID}..."
	curl -s -X DELETE -H "Authorization: Bearer $META_ACCESS_TOKEN" \
		"${META_GRAPH_BASE_URL}/${META_GRAPH_API_VERSION}/${META_WABA_ID}/subscribed_apps" | jq
}

# ---------------- App webhook URL (per env) ----------------

require_app_id() {
	: "${META_APP_ID:?ERROR: META_APP_ID not set in $ENV_FILE (required for set-url)}"
	: "${META_APP_SECRET:?ERROR: META_APP_SECRET not set in $ENV_FILE (required for set-url)}"
	: "${META_WEBHOOK_VERIFY_TOKEN:?ERROR: META_WEBHOOK_VERIFY_TOKEN not set in $ENV_FILE}"
}

# Uses app access token (APP_ID|APP_SECRET) — required to mutate /APP_ID/subscriptions.
app_token() {
	echo "${META_APP_ID}|${META_APP_SECRET}"
}

cmd_url_status() {
	require_app_id
	echo "→ Webhook configured on app ${META_APP_ID}:"
	# GET /APP_ID/subscriptions returns all subscriptions for the app.
	# DO NOT pass `object=...` — the API rejects with "(#100) object should
	# represent a valid URL". Filter client-side via jq.
	curl -s -G "${META_GRAPH_BASE_URL}/${META_GRAPH_API_VERSION}/${META_APP_ID}/subscriptions" \
		--data-urlencode "access_token=$(app_token)" \
		| jq '.data | map(select(.object == "whatsapp_business_account"))'
}

cmd_set_url() {
	require_app_id
	local url="${2:-}"
	if [ -z "$url" ]; then
		echo "ERROR: pass the full webhook URL."
		echo "  Example: $0 set-url https://abc.trycloudflare.com${META_WEBHOOK_PATH}"
		exit 1
	fi
	if [[ "$url" != https://* ]]; then
		echo "ERROR: URL must be HTTPS (Meta rejects HTTP)."
		exit 1
	fi
	echo "→ Updating webhook for app ${META_APP_ID}:"
	echo "   URL: $url"
	echo "   Fields: $META_WEBHOOK_FIELDS"
	curl -s -X POST "${META_GRAPH_BASE_URL}/${META_GRAPH_API_VERSION}/${META_APP_ID}/subscriptions" \
		--data-urlencode "object=whatsapp_business_account" \
		--data-urlencode "callback_url=${url}" \
		--data-urlencode "verify_token=${META_WEBHOOK_VERIFY_TOKEN}" \
		--data-urlencode "fields=${META_WEBHOOK_FIELDS}" \
		--data-urlencode "access_token=$(app_token)" | jq
	echo
	echo "Validating:"
	cmd_url_status
}

cmd_set_url_local() {
	local base="${2:-}"
	if [ -z "$base" ]; then
		echo "ERROR: pass the tunnel base URL."
		echo "  Example: $0 set-url-local https://abc.trycloudflare.com"
		exit 1
	fi
	base="${base%/}"
	cmd_set_url "set-url" "${base}${META_WEBHOOK_PATH}"
}

case "$CMD" in
	status)        cmd_status ;;
	subscribe)     cmd_subscribe ;;
	unsubscribe)   cmd_unsubscribe ;;
	url-status)    cmd_url_status ;;
	set-url)       cmd_set_url "$@" ;;
	set-url-local) cmd_set_url_local "$@" ;;
	*)
		echo "USAGE: $0 {status|subscribe|unsubscribe|url-status|set-url <url>|set-url-local <base>}"
		exit 1
		;;
esac
