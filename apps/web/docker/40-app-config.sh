#!/bin/sh
# Writes the SPA's runtime config, /config.js (window.__APP_CONFIG__), at container start. The nginx
# image runs every executable /docker-entrypoint.d/*.sh before nginx starts; a failure here stops
# the container, so a missing API_BASE_URL fails loudly instead of serving a broken app.
#
#   API_BASE_URL   required: the API's public base URL, e.g. https://api.camex-fin.site
#                  (https; plain http only for localhost, for local checks)
#   INBOX_ADDRESS  optional: the inbound address shown on /inbox, e.g. invoices@mg.camex-fin.site
#   APP_CONFIG_FILE  output path (default /usr/share/nginx/html/config.js; tests override it)
#
# Values are written as JSON strings (quotes and backslashes escaped, control characters
# refused), never substituted raw into JavaScript.
set -eu

out=${APP_CONFIG_FILE:-/usr/share/nginx/html/config.js}

fail() {
  echo "app-config: $*" >&2
  exit 1
}

# json_string VALUE NAME → VALUE as a JSON string literal
json_string() {
  case $1 in
    *[[:cntrl:]]*) fail "$2 must not contain control characters (newlines, tabs, ...)" ;;
  esac
  escaped=$(printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g')
  printf '"%s"' "$escaped"
}

api=${API_BASE_URL:-}
[ -n "$api" ] || fail "API_BASE_URL is required (the API's public base URL, e.g. https://api.camex-fin.site)"
case $api in
  *[[:space:]]*) fail "API_BASE_URL must not contain spaces" ;;
  https://?*) ;;
  http://localhost | http://localhost[:/]* | http://127.0.0.1 | http://127.0.0.1[:/]*) ;;
  *) fail "API_BASE_URL must be an absolute https:// URL (http:// only for localhost), got: $api" ;;
esac
# The SPA appends /api/... itself.
while [ "${api%/}" != "$api" ]; do api=${api%/}; done

api_json=$(json_string "$api" API_BASE_URL)
inbox_json=null
if [ -n "${INBOX_ADDRESS:-}" ]; then
  inbox_json=$(json_string "$INBOX_ADDRESS" INBOX_ADDRESS)
fi

printf 'window.__APP_CONFIG__ = {"apiBaseUrl":%s,"inboxAddress":%s};\n' "$api_json" "$inbox_json" >"$out"
echo "app-config: wrote $out (apiBaseUrl $api)"
