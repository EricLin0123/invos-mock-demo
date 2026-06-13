#!/usr/bin/env bash
# demo.sh — the "show the interviewer in 5 minutes" path. Brings the whole stack up from
# nothing and leaves you with two populated Grafana dashboards and a live k6 load run.
#
# Flow: compose up (Postgres + Prometheus + Grafana) -> migrate -> generate invoices
# (campaign ON) -> replay into the API -> run a k6 profile with Prometheus remote-write ->
# print the Grafana URLs and what to look at.
#
# Re-runnable: ingestion is idempotent, so a second run just reports duplicates.
#
# Env knobs:
#   K6_PROFILE   k6 profile to run at the end (default: smoke; try load/stress/soak)
#   SKIP_K6=1    skip the k6 run (just bring the stack up and replay)
#   SEED         generator seed (default 42)
set -euo pipefail

cd "$(dirname "$0")/.."   # repo root
ROOT="$(pwd)"

K6_PROFILE="${K6_PROFILE:-smoke}"
SEED="${SEED:-42}"
BASE_URL="${BASE_URL:-http://localhost:8473}"
NDJSON="generator/data/invoices_90d.ndjson"

say() { printf '\n\033[1;36m== %s\033[0m\n' "$*"; }

say "1/7 Bring up the stack (Postgres + Prometheus + Grafana)"
docker compose up -d
# Wait for Postgres to accept connections before migrating.
until docker compose exec -T postgres pg_isready -U invos -d invoices >/dev/null 2>&1; do
  printf '.'; sleep 1
done
echo " postgres ready"

say "2/7 Install server deps & migrate the schema"
( cd server && npm install --silent && npm run migrate )

say "3/7 Generate mock invoices (campaign ON)"
# config.yaml has campaign.enabled: true — the PearlGuard lift the analytics dashboard shows.
( cd generator && uv sync --quiet && uv run python -m generator --seed "$SEED" --out data/invoices_90d.ndjson )

say "4/7 Start the ingestion server on :8473"
if curl -sf "$BASE_URL/healthz" >/dev/null 2>&1; then
  echo "server already running"
else
  ( cd server && npm run start >/tmp/invos-server.log 2>&1 & echo $! >/tmp/invos-server.pid )
  until curl -sf "$BASE_URL/healthz" >/dev/null 2>&1; do printf '.'; sleep 1; done
  echo " server up (pid $(cat /tmp/invos-server.pid), logs: /tmp/invos-server.log)"
fi

say "5/7 Replay the generated invoices into the API"
( cd server && npm run replay -- "../$NDJSON" )

if [[ "${SKIP_K6:-0}" != "1" ]]; then
  say "6/7 Run k6 '$K6_PROFILE' with Prometheus remote-write"
  node loadtest/prepare.js
  ( cd loadtest && K6_PROMETHEUS_RW_SERVER_URL="http://localhost:9090/api/v1/write" \
      k6 run -o experimental-prometheus-rw "profiles/${K6_PROFILE}.js" )
else
  say "6/7 Skipping k6 (SKIP_K6=1)"
fi

say "7/7 Done — open Grafana"
cat <<EOF

  Grafana:     http://localhost:8474   (anonymous viewer; admin / \${GRAFANA_ADMIN_PASSWORD:-admin})
  Prometheus:  http://localhost:9090

  Dashboards (folder "invos-mock-demo"):
    • invos · System Performance   — request rate, latency p50/p95/p99, Node vitals,
                                      and k6 offered load vs server-observed rate.
                                      Re-run a longer profile to watch it live:
                                        K6_PROFILE=load bash scripts/demo.sh
    • invos · Invoice Analytics    — daily counts/revenue, top categories, weekend lift,
                                      and TOOTHPASTE BY BRAND: PearlGuard lifts after 2025-02-15.

  Stop everything:       bash scripts/stop-demo.sh   (add WIPE_DATA=1 to drop data volumes)
EOF
