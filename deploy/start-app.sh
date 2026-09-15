#!/usr/bin/env bash
set -euo pipefail

project_dir="/home/print/apps/UCAS-Course"
env_file="/home/print/.config/ucas-course.env"
data_dir="/home/print/.local/share/ucas-course"
image_name="ucas-course:latest"
container_name="ucas-course"

test -f "$env_file"
mkdir -p "$data_dir"

docker build --build-arg APP_BASE_PATH=/course -t "$image_name" "$project_dir"
docker rm -f "$container_name" >/dev/null 2>&1 || true
docker run -d \
  --name "$container_name" \
  --restart unless-stopped \
  --env-file "$env_file" \
  -e NODE_ENV=production \
  -e APP_BASE_PATH=/course \
  -e APP_HOST=0.0.0.0 \
  -e APP_PORT=3100 \
  -e AUTO_SIGN_DATA_DIR=/data \
  -p 127.0.0.1:3100:3100 \
  -v "$data_dir:/data" \
  "$image_name"

docker ps --filter "name=^/${container_name}$"
