#!/usr/bin/env bash
set -euo pipefail

project_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
dist_dir="${PORTABLE_OUTPUT_DIR:-$project_dir/dist}"
node_version="v22.14.0"

case "$(uname -s)" in
  Darwin) platform="macos"; node_platform="darwin" ;;
  Linux)
    platform="linux"; node_platform="linux"
    if ldd --version 2>&1 | grep -qi musl; then
      echo "暂不支持 Alpine/musl；请在 glibc Linux 上构建并运行。" >&2
      exit 1
    fi
    ;;
  *) echo "此脚本只支持 macOS 和 Linux；Windows 请使用 npm run build:windows。" >&2; exit 1 ;;
esac

case "$(uname -m)" in
  x86_64|amd64) arch="x64" ;;
  arm64|aarch64) arch="arm64" ;;
  *) echo "不支持的 CPU 架构：$(uname -m)" >&2; exit 1 ;;
esac

command -v curl >/dev/null
command -v tar >/dev/null
command -v node >/dev/null
command -v npm >/dev/null
mkdir -p "$dist_dir"
dist_dir="$(cd -- "$dist_dir" && pwd)"
stage_dir="$(mktemp -d "$dist_dir/.portable-stage.XXXXXXXX")"
trap 'rm -rf -- "$stage_dir"' EXIT

package_name="UCAS-Course-Portable-$platform-$arch"
package_dir="$stage_dir/$package_name"
archive_path="$dist_dir/$package_name.tar.gz"
node_archive="node-$node_version-$node_platform-$arch.tar.gz"
node_url="https://nodejs.org/dist/$node_version/$node_archive"

cd "$project_dir"
APP_BASE_PATH= NEXT_PUBLIC_BASE_PATH= npm run build

test -f .next/standalone/server.js
test -d .next/static
mkdir -p "$package_dir/.next/static" "$package_dir/runtime" "$package_dir/scripts" "$package_dir/src/automation" "$package_dir/src/qq"
cp -R .next/standalone/. "$package_dir/"
cp -R .next/static/. "$package_dir/.next/static/"
cp -R public "$package_dir/public"
cp src/worker-multi.mjs src/ucas.mjs src/schedule.mjs "$package_dir/src/"
cp src/automation/*.mjs "$package_dir/src/automation/"
cp src/qq/store.mjs src/qq/events.mjs src/qq/format.mjs "$package_dir/src/qq/"
cp scripts/portable-launcher.mjs "$package_dir/scripts/"
cp scripts/start-unix.sh "$package_dir/Start-UCAS-Course.sh"
cp README-PORTABLE.txt LICENSE "$package_dir/"

# Keep the same desktop-only middleware adjustment as the Windows portable build.
rm -f -- "$package_dir/.next/server/middleware.js"
node -e 'require("node:fs").writeFileSync(process.argv[1], JSON.stringify({version:3,middleware:{},sortedMiddleware:[],functions:{}},null,2))' \
  "$package_dir/.next/server/middleware-manifest.json"

curl --fail --location --silent --show-error "https://nodejs.org/dist/$node_version/SHASUMS256.txt" -o "$stage_dir/SHASUMS256.txt"
curl --fail --location --silent --show-error "$node_url" -o "$stage_dir/$node_archive"
expected_sha="$(awk -v name="$node_archive" '$2 == name { print $1 }' "$stage_dir/SHASUMS256.txt")"
test -n "$expected_sha"
if command -v sha256sum >/dev/null 2>&1; then
  actual_sha="$(sha256sum "$stage_dir/$node_archive" | awk '{print $1}')"
else
  actual_sha="$(shasum -a 256 "$stage_dir/$node_archive" | awk '{print $1}')"
fi
test "$actual_sha" = "$expected_sha" || { echo "Node.js 运行时 SHA256 校验失败" >&2; exit 1; }
tar -xzf "$stage_dir/$node_archive" -C "$stage_dir" "node-$node_version-$node_platform-$arch/bin/node"
cp "$stage_dir/node-$node_version-$node_platform-$arch/bin/node" "$package_dir/runtime/node"
chmod 755 "$package_dir/runtime/node" "$package_dir/Start-UCAS-Course.sh"
if [[ "$platform" == "macos" ]]; then
  cp scripts/start-unix.sh "$package_dir/Start-UCAS-Course.command"
  chmod 755 "$package_dir/Start-UCAS-Course.command"
fi

node scripts/audit-portable.mjs "$package_dir"
tar -czf "$archive_path" -C "$stage_dir" "$package_name"
if command -v sha256sum >/dev/null 2>&1; then
  archive_sha="$(sha256sum "$archive_path" | awk '{print $1}')"
else
  archive_sha="$(shasum -a 256 "$archive_path" | awk '{print $1}')"
fi
printf '%s  %s\n' "$archive_sha" "$(basename "$archive_path")" > "$archive_path.sha256"
echo "便携包已生成：$archive_path"
