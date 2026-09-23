#!/usr/bin/env bash
set -euo pipefail

project_dir="${PROJECT_DIR:-$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)}"
env_file="${ENV_FILE:?Set ENV_FILE to the protected application environment file}"
data_dir="${DATA_DIR:?Set DATA_DIR to the persistent application data directory}"
run_user="${RUN_USER:?Set RUN_USER to the unprivileged service account}"
node_bin="${NODE_BIN:-$(command -v node)}"
npm_bin="${NPM_BIN:-$(command -v npm)}"
app_base_path="${APP_BASE_PATH:-/course}"
app_port="${APP_PORT:-3100}"
service_file="${SERVICE_FILE:-/etc/systemd/system/ucas-course.service}"

test -f "$env_file"
mkdir -p "$data_dir"
chown -R "$run_user:$run_user" "$project_dir" "$data_dir"
chmod 750 "$data_dir"
chown "root:$run_user" "$env_file"
chmod 640 "$env_file"

cd "$project_dir"
runuser -u "$run_user" -- env \
  npm_config_registry="https://registry.npmmirror.com" \
  npm_config_replace_registry_host="always" \
  "$npm_bin" ci --no-audit --no-fund
runuser -u "$run_user" -- env APP_BASE_PATH="$app_base_path" "$npm_bin" run build

sed \
  -e "s|@@RUN_USER@@|$run_user|g" \
  -e "s|@@PROJECT_DIR@@|$project_dir|g" \
  -e "s|@@ENV_FILE@@|$env_file|g" \
  -e "s|@@DATA_DIR@@|$data_dir|g" \
  -e "s|@@NODE_BIN@@|$node_bin|g" \
  -e "s|@@APP_BASE_PATH@@|$app_base_path|g" \
  -e "s|@@APP_PORT@@|$app_port|g" \
  "$project_dir/deploy/ucas-course.service" > "$service_file"
chmod 0644 "$service_file"
systemctl daemon-reload
systemctl enable ucas-course.service
systemctl restart ucas-course.service
systemctl --no-pager --full status ucas-course.service
