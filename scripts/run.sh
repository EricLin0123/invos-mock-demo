#!/usr/bin/env bash
# run.sh — bring the stack up on a local Kubernetes (kind) cluster, then run any k6 profile.
#
#   bash scripts/run.sh up                          # kind cluster + build/load image + apply
#                                                   # manifests + migrate + generate + k6 feed
#   bash scripts/run.sh smoke|load|stress|scale|soak  # run that k6 profile (Prometheus overlay ON)
#   bash scripts/run.sh down                        # delete the cluster (WIPE_DATA=1 first deletes
#                                                   # the Postgres PVC for a clean slate)
#
# The ingest service now runs as a horizontally-scalable Deployment behind an HPA — there is
# no host-run Node process anymore. k6 stays on the host and targets the kind NodePort,
# surfaced on localhost:8473 via kind-config.yaml.
#
# Env knobs: COUNT (invoices to generate, default 100000), SEED (default 42),
#            BASE_URL (default http://localhost:8473), CLUSTER (kind cluster name, default invos),
#            IMAGE (server image tag, default invos-ingest:dev).
set -euo pipefail

cd "$(dirname "$0")/.."   # repo root
BASE_URL="${BASE_URL:-http://localhost:8473}"
COUNT="${COUNT:-100000}"
SEED="${SEED:-42}"
CLUSTER="${CLUSTER:-invos}"
IMAGE="${IMAGE:-invos-ingest:dev}"
NS="invos"

say() { printf '\n\033[1;36m== %s\033[0m\n' "$*"; }
die() { echo "ERROR: $*" >&2; exit 1; }

require_tools() {
  for t in docker kind kubectl; do
    command -v "$t" >/dev/null 2>&1 || die "'$t' not found on PATH. Install it first (kind: https://kind.sigs.k8s.io, kubectl: https://kubernetes.io/docs/tasks/tools/)."
  done
}

require_server() {
  if ! curl -sf "$BASE_URL/healthz" >/dev/null 2>&1; then
    echo "Ingest service is not reachable at $BASE_URL. Run 'bash scripts/run.sh up' first." >&2
    exit 1
  fi
}

up() {
  require_tools

  say "1/8 Create the kind cluster '$CLUSTER' (if absent)"
  if kind get clusters 2>/dev/null | grep -qx "$CLUSTER"; then
    echo "cluster '$CLUSTER' already exists"
  else
    kind create cluster --name "$CLUSTER" --config kind-config.yaml
  fi
  kubectl config use-context "kind-$CLUSTER" >/dev/null

  say "2/8 Build the server image and load it into kind"
  docker build -f server/Dockerfile -t "$IMAGE" .
  kind load docker-image "$IMAGE" --name "$CLUSTER"

  say "3/8 Install metrics-server (HPA resource metrics) — patched for kind"
  kubectl apply -f https://github.com/kubernetes-sigs/metrics-server/releases/latest/download/components.yaml
  # kind kubelets serve TLS with certs metrics-server won't verify by default.
  kubectl patch deployment metrics-server -n kube-system --type=json \
    -p='[{"op":"add","path":"/spec/template/spec/containers/0/args/-","value":"--kubelet-insecure-tls"}]' \
    >/dev/null 2>&1 || true

  say "4/8 Apply manifests (namespace, ConfigMaps from monitoring/, then the stack)"
  # Namespace first so the generated ConfigMaps land in it.
  kubectl apply -f k8s/namespace.yaml
  # Grafana provisioning + dashboards + Prometheus scrape config are generated verbatim from
  # the monitoring/ files (single source of truth) — kustomize can't reference them directly.
  kubectl create configmap grafana-datasources -n "$NS" \
    --from-file=monitoring/grafana/provisioning/datasources/datasources.yml \
    --dry-run=client -o yaml | kubectl apply -f -
  kubectl create configmap grafana-dashboards-provider -n "$NS" \
    --from-file=monitoring/grafana/provisioning/dashboards/dashboards.yml \
    --dry-run=client -o yaml | kubectl apply -f -
  kubectl create configmap grafana-dashboards -n "$NS" \
    --from-file=monitoring/grafana/dashboards/ \
    --dry-run=client -o yaml | kubectl apply -f -
  kubectl create configmap prometheus-config -n "$NS" \
    --from-file=monitoring/prometheus/prometheus.yml \
    --dry-run=client -o yaml | kubectl apply -f -
  kubectl apply -k k8s/

  say "5/8 Wait for Postgres + ingest rollout"
  kubectl rollout status statefulset/postgres -n "$NS" --timeout=180s
  kubectl rollout status deployment/pgbouncer -n "$NS" --timeout=120s
  kubectl rollout status deployment/invos-ingest -n "$NS" --timeout=180s

  say "6/8 Run the migration Job (idempotent)"
  kubectl delete job invos-migrate -n "$NS" --ignore-not-found
  kubectl apply -f k8s/migrate-job.yaml
  kubectl wait --for=condition=complete job/invos-migrate -n "$NS" --timeout=120s

  say "7/8 Generate $COUNT mock invoices (seed $SEED)"
  ( cd generator && uv sync --quiet && \
      uv run python -m generator --seed "$SEED" --count "$COUNT" --out data/invoices_90d.ndjson )

  # No replay — the DB starts empty; the k6 tests are what populate it.
  say "8/8 Prepare the k6 data feed"
  node loadtest/prepare.js

  cat <<EOF

Stack is up on kind cluster '$CLUSTER'.
  Ingest API : http://localhost:8473   (NodePort 30847)
  Grafana    : http://localhost:8474   (open "System Performance" -> Autoscaling panel)
  Prometheus : http://localhost:9090

  Run a test:   bash scripts/run.sh smoke    # 5 req/s, ~1 min
                bash scripts/run.sh load     # ramp 0->100 req/s, hold 10 min
                bash scripts/run.sh stress   # step 100->800 req/s until a threshold breaks
                bash scripts/run.sh scale    # ramp UP then DOWN — watch pods grow/shrink (HPA)
                bash scripts/run.sh soak     # 50 req/s, 60 min
  Watch pods:   kubectl get hpa,pods -n $NS -w
  Tear down:    bash scripts/run.sh down     # add WIPE_DATA=1 to also drop the Postgres PVC
EOF
}

run_profile() {
  local profile="$1"
  require_server
  say "Run k6 '$profile' (Prometheus remote-write ON — watch it live in Grafana)"
  K6_PROM=1 make "k6-$profile"
}

down() {
  require_tools
  if [[ "${WIPE_DATA:-0}" == "1" ]]; then
    say "Tear down: delete kind cluster '$CLUSTER' (PVC included)"
  else
    say "Tear down: delete kind cluster '$CLUSTER'"
  fi
  # Stop any host-side k6 still running.
  pkill -x k6 2>/dev/null && echo "killed k6" || true
  # Deleting the cluster removes everything, PVC included. WIPE_DATA is accepted for symmetry
  # with the old compose flow; there is no separately-persisted volume to keep.
  if kind get clusters 2>/dev/null | grep -qx "$CLUSTER"; then
    kind delete cluster --name "$CLUSTER"
    echo "cluster '$CLUSTER' deleted"
  else
    echo "cluster '$CLUSTER' not found (nothing to do)"
  fi
}

cmd="${1:-}"
case "$cmd" in
  up)                              up ;;
  smoke|load|stress|scale|soak)    run_profile "$cmd" ;;
  down)                            down ;;
  *)
    echo "usage: bash scripts/run.sh {up|smoke|load|stress|scale|soak|down}" >&2
    exit 1
    ;;
esac
