#!/usr/bin/env bash
set -euo pipefail

project_dir="/home/print/apps/UCAS-Course"
config_name="ucas-course"

install -m 0644 "$project_dir/deploy/nginx-course.conf" "/etc/nginx/sites-available/$config_name"
ln -sfn "/etc/nginx/sites-available/$config_name" "/etc/nginx/sites-enabled/$config_name"
nginx -t
systemctl reload nginx

if command -v certbot >/dev/null 2>&1; then
  certbot --nginx --non-interactive --agree-tos --register-unsafely-without-email --redirect -d source.cskaoyan.cn
fi

nginx -t
systemctl reload nginx
