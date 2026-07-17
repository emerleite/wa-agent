#!/usr/bin/env bash
# Manage WhatsApp Business templates via Graph API.
#
# USAGE
#   bash scripts/meta-templates.sh check                  # validate token + WABA access
#   bash scripts/meta-templates.sh list                   # list all templates
#   bash scripts/meta-templates.sh create <file.json>     # create from JSON file
#   bash scripts/meta-templates.sh delete <name>          # delete by name
#
# Reads .dev.vars (development) by default. For other envs:
#   ENV_FILE=.dev.vars.staging bash scripts/meta-templates.sh ...
#
# Required env vars:
#   META_ACCESS_TOKEN     System User token with whatsapp_business_management
#   META_WABA_ID          WhatsApp Business Account ID
#
# Optional overrides:
#   META_GRAPH_BASE_URL   default https://graph.facebook.com
#   META_GRAPH_API_VERSION  default v22.0

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

: "${META_ACCESS_TOKEN:?ERROR: META_ACCESS_TOKEN not set in $ENV_FILE}"
: "${META_WABA_ID:?ERROR: META_WABA_ID not set in $ENV_FILE}"

CMD="${1:-help}"

cmd_check() {
	echo "→ Verifying token + WABA access..."
	echo
	echo "Token info (debug_token):"
	curl -s "${META_GRAPH_BASE_URL}/${META_GRAPH_API_VERSION}/debug_token?input_token=${META_ACCESS_TOKEN}&access_token=${META_ACCESS_TOKEN}" \
		| jq '.data | { app_id, type, scopes, expires_at, is_valid, granular_scopes }'
	echo
	echo "WABA info (${META_WABA_ID}):"
	curl -s -H "Authorization: Bearer $META_ACCESS_TOKEN" \
		"${META_GRAPH_BASE_URL}/${META_GRAPH_API_VERSION}/${META_WABA_ID}?fields=id,name,timezone_id,message_template_namespace" | jq
}

cmd_list() {
	echo "→ Listing templates for WABA ${META_WABA_ID}..."
	curl -s -H "Authorization: Bearer $META_ACCESS_TOKEN" \
		"${META_GRAPH_BASE_URL}/${META_GRAPH_API_VERSION}/${META_WABA_ID}/message_templates?fields=name,language,status,category,components&limit=100" | jq
}

cmd_create() {
	local file="${2:-}"
	if [ -z "$file" ]; then
		echo "ERROR: pass the path to a template JSON file."
		echo "  Example: $0 create ./templates/lead_notification.json"
		exit 1
	fi
	if [ ! -f "$file" ]; then
		echo "ERROR: file '$file' does not exist."
		exit 1
	fi
	echo "→ Creating template from '$file'..."
	curl -s -X POST -H "Authorization: Bearer $META_ACCESS_TOKEN" \
		-H "Content-Type: application/json" \
		"${META_GRAPH_BASE_URL}/${META_GRAPH_API_VERSION}/${META_WABA_ID}/message_templates" \
		--data-binary "@$file" | jq
}

cmd_delete() {
	local name="${2:-}"
	if [ -z "$name" ]; then
		echo "ERROR: pass the template name. Example: $0 delete my_template_v1"
		exit 1
	fi
	echo "→ Deleting template '${name}'..."
	curl -s -X DELETE -H "Authorization: Bearer $META_ACCESS_TOKEN" \
		"${META_GRAPH_BASE_URL}/${META_GRAPH_API_VERSION}/${META_WABA_ID}/message_templates?name=${name}" | jq
}

case "$CMD" in
	check)  cmd_check ;;
	list)   cmd_list ;;
	create) cmd_create "$@" ;;
	delete) cmd_delete "$@" ;;
	*)
		echo "USAGE: $0 {check|list|create <file.json>|delete <name>}"
		exit 1
		;;
esac
