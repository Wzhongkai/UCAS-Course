#!/usr/bin/env bash
set -euo pipefail

project_dir="/srv/ucas-course"
env_file="/etc/ucas-course.env"
data_dir="/var/lib/ucas-course"
node_dir="/opt/node24-current/bin"
service_file="/etc/systemd/system/ucas-course.service"

test -f "$env_file"
mkdir -p "$data_dir"
chown -R deploy:deploy "$project_dir" "$data_dir"
chmod 750 "$data_dir"
chown root:deploy "$env_file"
chmod 640 "$env_file"

cd "$project_dir"
runuser -u deploy -- env \
  PATH="$node_dir:/usr/local/bin:/usr/bin:/bin" \
  npm_config_registry="https://registry.npmmirror.com" \
  npm_config_replace_registry_host="always" \
  npm ci --no-audit --no-fund
runuser -u deploy -- env PATH="$node_dir:/usr/local/bin:/usr/bin:/bin" APP_BASE_PATH=/course npm run build

install -m 0644 "$project_dir/deploy/ucas-course.service" "$service_file"
systemctl daemon-reload
systemctl enable ucas-course.service
systemctl restart ucas-course.service
systemctl --no-pager --full status ucas-course.service
