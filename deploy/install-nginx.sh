#!/usr/bin/env bash
set -euo pipefail

project_dir="${PROJECT_DIR:?Set PROJECT_DIR to the checked-out repository path}"
site_file="${NGINX_SITE_FILE:?Set NGINX_SITE_FILE to the target server block file}"
snippet_file="${NGINX_SNIPPET_FILE:-/etc/nginx/snippets/ucas-course.conf}"
include_line="    include $snippet_file;"
insert_before="${NGINX_INSERT_BEFORE:-^[[:space:]]*location }"

test -f "$site_file"
if [[ -n "${TLS_CERT_FILE:-}" ]]; then
  test -f "$TLS_CERT_FILE"
fi
install -m 0644 "$project_dir/deploy/nginx-course.conf" "$snippet_file"

if ! grep -qF "$include_line" "$site_file"; then
  cp -a "$site_file" "$site_file.backup-$(date +%Y%m%d-%H%M%S)-ucas-course"
  sed -i "/$insert_before/i\\$include_line" "$site_file"
fi

nginx -t
systemctl reload nginx
