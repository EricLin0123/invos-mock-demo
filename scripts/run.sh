#!/usr/bin/env bash
# run.sh — bring the stack up, then run any of the four k6 tests.
#
#   bash scripts/run.sh up                  # stack + server + generated data + replay
#   bash scripts/run.sh smoke|load|stress|soak   # run that k6 profile (Prometheus overlay ON)
#   bash scripts/run.sh down                # stop everything (WIPE_DATA=1 also drops volumes)
#
# Env knobs: COUNT (invoices to generate, default 100000), SEED (default 42),
#            BASE_URL (default http://localhost:8473).
set -euo pipefail

cd "$(dirname "$0")/.."   # repo root
BASE_URL="${BASE_URL:-http://localhost:8473}"
COUNT="${COUNT:-100000}"
SEED="${SEED:-42}"
NDJSON="generator/data/invoices_90d.ndjson"

say() { printf '\n\033[1;36m== %s\033[0m\n' "$*"; }

require_server() {
  if ! curl -sf "$BASE_URL/healthz" >/dev/null 2>&1; then
    echo "Ingestion server is not up. Run 'bash scripts/run.sh up' first." >&2
    exit 1
  fi
}

up() {
  say "1/6 Bring up the stack (Postgres + Prometheus + Grafana)"
  docker compose up -d
  until docker compose exec -T postgres pg_isready -U invos -d invoices >/dev/null 2>&1; do
    printf '.'; sleep 1
  done
  echo " postgres ready"

  say "2/6 Install server deps & migrate the schema"
  ( cd server && npm install --silent && npm run migrate )

  say "3/6 Generate $COUNT mock invoices (seed $SEED)"
  ( cd generator && uv sync --quiet && \
      uv run python -m generator --seed "$SEED" --count "$COUNT" --out data/invoices_90d.ndjson )

  say "4/6 Start the ingestion server on :8473"
  if curl -sf "$BASE_URL/healthz" >/dev/null 2>&1; then
    echo "server already running"
  else
    ( cd server && npm run start >/tmp/invos-server.log 2>&1 & echo $! >/tmp/invos-server.pid )
    until curl -sf "$BASE_URL/healthz" >/dev/null 2>&1; do printf '.'; sleep 1; done
    echo " server up (pid $(cat /tmp/invos-server.pid), logs: /tmp/invos-server.log)"
  fi

  say "5/6 Replay the generated invoices into the API"
  ( cd server && npm run replay -- "../$NDJSON" )

  say "6/6 Prepare the k6 data feed"
  node loadtest/prepare.js

  cat <<EOF

Stack is up. Grafana: http://localhost:8474  (open the "System Performance" dashboard)

  Run a test:   bash scripts/run.sh smoke    # 5 req/s, ~1 min
                bash scripts/run.sh load     # ramp 0->100 req/s, hold 10 min
                bash scripts/run.sh stress   # step 100->800 req/s until a threshold breaks
                bash scripts/run.sh soak     # 50 req/s, 60 min
  Tear down:    bash scripts/run.sh down     # add WIPE_DATA=1 to also drop data volumes
EOF
}

run_profile() {
  local profile="$1"
  require_server
  say "Run k6 '$profile' (Prometheus remote-write ON — watch it live in Grafana)"
  K6_PROM=1 make "k6-$profile"
}

down() {
  say "Tear down (host server, k6, compose stack)"
  bash scripts/stop-demo.sh
}

cmd="${1:-}"
case "$cmd" in
  up)                       up ;;
  smoke|load|stress|soak)   run_profile "$cmd" ;;
  down)                     down ;;
  *)
    echo "usage: bash scripts/run.sh {up|smoke|load|stress|soak|down}" >&2
    exit 1
    ;;
esac
