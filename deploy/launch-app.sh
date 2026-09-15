#!/usr/bin/env bash
set -euo pipefail

project_dir="/home/print/apps/UCAS-Course"
runtime_dir="/home/print/.local/share/ucas-course"
run_script="$project_dir/deploy/run-app.sh"
pid_file="$runtime_dir/app.pid"

mkdir -p "$runtime_dir"

if [[ -f "$pid_file" ]]; then
  old_pid="$(cat "$pid_file")"
  if [[ "$old_pid" =~ ^[0-9]+$ ]] && kill -0 "$old_pid" 2>/dev/null; then
    if tr '\0' ' ' <"/proc/$old_pid/cmdline" | grep -Fq "$run_script"; then
      kill -TERM -- "-$old_pid" 2>/dev/null || true
      for _ in {1..25}; do
        kill -0 "$old_pid" 2>/dev/null || break
        sleep 0.2
      done
      kill -KILL -- "-$old_pid" 2>/dev/null || true
    fi
  fi
fi

rm -f "$pid_file"
nohup setsid bash "$run_script" >/dev/null 2>&1 &
new_pid=$!
printf '%s\n' "$new_pid" >"$pid_file"
sleep 1
kill -0 "$new_pid"
printf 'UCAS Course started with supervisor PID %s\n' "$new_pid"
