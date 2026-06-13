#!/usr/bin/env bash
# stop-demo.sh — the inverse of demo.sh. Terminates everything demo.sh started:
# the host ingestion server, any running k6, and the Docker Compose stack
# (Postgres + Prometheus + Grafana).
#
# By default the Postgres/Prometheus/Grafana data volumes are KEPT, so the next
# `bash scripts/demo.sh` starts fast and a re-run just reports duplicates.
#
# Env knobs:
#   WIPE_DATA=1   also remove the named volumes (docker compose down -v) — a clean slate.
set -euo pipefail

cd "$(dirname "$0")/.."   # repo root

PID_FILE="/tmp/invos-server.pid"
LOG_FILE="/tmp/invos-server.log"
BASE_URL="${BASE_URL:-http://localhost:8473}"

say() { printf '\n\033[1;36m== %s\033[0m\n' "$*"; }

say "1/3 Stop the host ingestion server"
if [[ -f "$PID_FILE" ]]; then
  PID="$(cat "$PID_FILE")"
  if kill "$PID" 2>/dev/null; then
    echo "killed server (pid $PID)"
  else
    echo "pid $PID not running"
  fi
  rm -f "$PID_FILE" "$LOG_FILE"
else
  # No pid file (server may have been started by hand). Fall back to whatever
  # is listening on :8473 so we don't leave an orphan behind.
  if PIDS="$(lsof -ti tcp:8473 2>/dev/null)" && [[ -n "$PIDS" ]]; then
    echo "$PIDS" | xargs kill 2>/dev/null && echo "killed process(es) on :8473 ($PIDS)"
  else
    echo "no host server found"
  fi
fi

say "2/3 Stop any running k6 load test"
if pkill -x k6 2>/dev/null; then
  echo "killed k6"
else
  echo "no k6 running"
fi

say "3/3 Tear down the Docker Compose stack"
if [[ "${WIPE_DATA:-0}" == "1" ]]; then
  docker compose down -v
  echo "containers and volumes removed (clean slate)"
else
  docker compose down
  echo "containers removed; data volumes kept (set WIPE_DATA=1 to remove them)"
fi

say "Done — all demo processes terminated"
