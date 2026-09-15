#!/usr/bin/env bash
set -euo pipefail

project_dir="/home/print/apps/UCAS-Course"
env_file="/home/print/.config/ucas-course.env"
data_dir="/home/print/.local/share/ucas-course"
cron_marker="# UCAS Course"
cron_line="@reboot /bin/bash $project_dir/deploy/launch-app.sh $cron_marker"

test -f "$env_file"
mkdir -p "$data_dir"

cd "$project_dir"
npm ci
APP_BASE_PATH=/course npm run build

cron_file="$(mktemp)"
trap 'rm -f "$cron_file"' EXIT
crontab -l 2>/dev/null | grep -vF "$cron_marker" >"$cron_file" || true
printf '%s\n' "$cron_line" >>"$cron_file"
crontab "$cron_file"

bash "$project_dir/deploy/launch-app.sh"
