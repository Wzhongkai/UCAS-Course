#!/bin/sh
set -eu

package_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$package_dir"
exec "$package_dir/runtime/node" "$package_dir/scripts/portable-launcher.mjs"
