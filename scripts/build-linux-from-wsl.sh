#!/usr/bin/env bash
set -euo pipefail

source_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
output_dir="$source_dir/dist"
mkdir -p "$output_dir"
build_dir="$(mktemp -d /tmp/ucas-course-linux-build.XXXXXXXX)"
cleanup() {
  case "$build_dir" in
    /tmp/ucas-course-linux-build.*) rm -rf -- "$build_dir" ;;
  esac
}
trap cleanup EXIT

# Install and build in the Linux filesystem so Windows node_modules never
# replace the native optional dependencies needed by the Linux bundle.
tar -C "$source_dir" \
  --exclude='./.git' --exclude='./node_modules' --exclude='./.next' \
  --exclude='./dist' --exclude='./data' --exclude='./.env.local' \
  --exclude='./AGENTS.md' --exclude='./CLAUDE.md' \
  -cf - . | tar -C "$build_dir" -xf -
cd "$build_dir"
npm ci
npm run build:portable
cp dist/UCAS-Course-Portable-linux-*.tar.gz* "$output_dir/"
echo "Linux 便携包已复制到 $output_dir"
