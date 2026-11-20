#!/usr/bin/env bash
set -euo pipefail

env_file="${ENV_FILE:-/etc/ucas-course.env}"
app_host="${APP_HOST:-127.0.0.1}"
app_port="${APP_PORT:-3110}"
app_base_path="${APP_BASE_PATH:-/course}"
service_name="${SERVICE_NAME:-ucas-course.service}"
origin="http://${app_host}:${app_port}"
base_url="${APP_BASE_URL:-${origin}${app_base_path}}"

set -a
source "$env_file"
set +a

cookie_file="$(mktemp)"
response_file="$(mktemp)"
trap 'rm -f "$cookie_file" "$response_file"' EXIT

redirect_code="$(curl -sS -o /dev/null -w '%{http_code}' "$base_url")"
[[ "$redirect_code" == "307" ]]

payload="$(node -e 'process.stdout.write(JSON.stringify({ key: process.env.UCAS_ACCESS_KEY }))')"
login_code="$(curl -sS -o /dev/null -w '%{http_code}' \
  -c "$cookie_file" \
  -H 'Content-Type: application/json' \
  -H "Origin: $origin" \
  --data-binary "$payload" \
  "$base_url/api/access")"
[[ "$login_code" == "200" ]]

home_code="$(curl -sS -o "$response_file" -w '%{http_code}' -b "$cookie_file" "$base_url")"
[[ "$home_code" == "200" ]]
grep -q 'UCAS Course' "$response_file"
systemctl is-active --quiet "$service_name"
systemctl is-enabled --quiet "$service_name"

printf 'access_redirect=%s login=%s home=%s service=running reboot=enabled\n' \
  "$redirect_code" "$login_code" "$home_code"
