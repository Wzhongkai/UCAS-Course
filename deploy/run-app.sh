#!/usr/bin/env bash
set -euo pipefail

project_dir="/home/print/apps/UCAS-Course"
env_file="/home/print/.config/ucas-course.env"
runtime_dir="/home/print/.local/share/ucas-course"

mkdir -p "$runtime_dir"
exec 9>"$runtime_dir/app.lock"
flock -n 9 || exit 0

set -a
source "$env_file"
set +a

export NODE_ENV=production
export APP_BASE_PATH=/course
export APP_HOST=127.0.0.1
export APP_PORT=3100
export AUTO_SIGN_DATA_DIR="$runtime_dir"

cd "$project_dir"
while true; do
  npm start >>"$runtime_dir/app.log" 2>&1 || true
  sleep 5
done
