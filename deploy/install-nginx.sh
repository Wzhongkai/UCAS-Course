#!/usr/bin/env bash
set -euo pipefail

project_dir="/srv/ucas-course"
site_file="/etc/nginx/sites-available/source.cskaoyan.cn"
snippet_file="/etc/nginx/snippets/ucas-course.conf"
include_line="    include /etc/nginx/snippets/ucas-course.conf;"

test -f "$site_file"
test -f /etc/letsencrypt/live/source.cskaoyan.cn/fullchain.pem
install -m 0644 "$project_dir/deploy/nginx-course.conf" "$snippet_file"

if ! grep -qF "$include_line" "$site_file"; then
  cp -a "$site_file" "$site_file.backup-$(date +%Y%m%d-%H%M%S)-ucas-course"
  sed -i "/^[[:space:]]*location \^~ \/counter\/ {/i\\$include_line" "$site_file"
fi

nginx -t
systemctl reload nginx
