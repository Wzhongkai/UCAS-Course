#!/usr/bin/env bash
set -euo pipefail

env_file="/etc/ucas-course.env"
base_url="http://127.0.0.1:3110/course"

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
  -H 'Origin: http://127.0.0.1:3110' \
  --data-binary "$payload" \
  "$base_url/api/access")"
[[ "$login_code" == "200" ]]

home_code="$(curl -sS -o "$response_file" -w '%{http_code}' -b "$cookie_file" "$base_url")"
[[ "$home_code" == "200" ]]
grep -q 'UCAS Course' "$response_file"
systemctl is-active --quiet ucas-course.service
systemctl is-enabled --quiet ucas-course.service

printf 'access_redirect=%s login=%s home=%s service=running reboot=enabled\n' \
  "$redirect_code" "$login_code" "$home_code"
