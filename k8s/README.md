# k8s/ — Kubernetes manifests for invos-mock-demo

This directory holds the kustomize base that runs the whole stack on a local **kind**
cluster: Postgres, PgBouncer, the autoscaled ingest API, Prometheus, Grafana, and
kube-state-metrics. The ingest service is no longer a host process — it is a horizontally
scalable `Deployment` managed by an HPA.

Everything is driven from the repo root by `scripts/run.sh up` (which creates the cluster,
builds + `kind load`s the image, generates the ConfigMaps, applies these manifests, runs the
migrate Job, and prepares the k6 feed). The notes below are for applying things by hand.

## Apply by hand

```bash
# 1. cluster + image (see kind-config.yaml at the repo root for the NodePort mappings)
kind create cluster --name invos --config kind-config.yaml
docker build -f server/Dockerfile -t invos-ingest:dev .
kind load docker-image invos-ingest:dev --name invos

# 2. HPA resource metrics
kubectl apply -f https://github.com/kubernetes-sigs/metrics-server/releases/latest/download/components.yaml
kubectl patch deployment metrics-server -n kube-system --type=json \
  -p='[{"op":"add","path":"/spec/template/spec/containers/0/args/-","value":"--kubelet-insecure-tls"}]'

# 3. namespace + ConfigMaps generated from monitoring/ (see "ConfigMaps" below), then the base
kubectl apply -f k8s/namespace.yaml
#    ...create the four ConfigMaps (run.sh does this)...
kubectl apply -k k8s/

# 4. schema migration (Job template is immutable, so delete + re-apply)
kubectl delete job invos-migrate -n invos --ignore-not-found
kubectl apply -f k8s/migrate-job.yaml
kubectl wait --for=condition=complete job/invos-migrate -n invos --timeout=120s
```

## The manifests

| File | What it is |
|---|---|
| `namespace.yaml` | the `invos` namespace |
| `postgres-secret.yaml` | demo credentials + `DATABASE_URL` (via PgBouncer) and `DATABASE_URL_DIRECT` |
| `postgres-statefulset.yaml` / `postgres-svc.yaml` | single-replica Postgres + PVC — the deliberate shared bottleneck |
| `pgbouncer.yaml` | transaction-pooling proxy in front of Postgres |
| `ingest-deployment.yaml` / `ingest-svc.yaml` | the scalable ingest API + NodePort `30847` |
| `ingest-hpa.yaml` | **default** HPA — CPU utilization |
| `migrate-job.yaml` | one-shot schema migration (applied separately by `run.sh`) |
| `prometheus-rbac.yaml` / `prometheus-deployment.yaml` | in-cluster Prometheus with Kubernetes SD + NodePort `30909` |
| `grafana-deployment.yaml` | Grafana + NodePort `30848`, reusing `monitoring/grafana/` verbatim |
| `kube-state-metrics.yaml` | replica/HPA timeseries for the autoscaling panel |
| `kustomization.yaml` | the base — lists the resources above (minus the opt-in ones) |
| `ingest-hpa-custom.yaml` | **opt-in** HPA — per-pod requests/second (custom metric) |
| `prometheus-adapter.yaml` | **opt-in** custom.metrics.k8s.io backend the custom HPA needs |

## ConfigMaps (why they are not in kustomize)

Grafana's provisioning + dashboards and Prometheus' scrape config live under `monitoring/`,
the single source of truth shared with the legacy compose path. `kubectl`'s built-in
kustomize forbids `configMapGenerator` from reading files outside `k8s/` (the load
restrictor), so `run.sh` creates them imperatively instead, right after the namespace:

```bash
kubectl create configmap grafana-datasources -n invos \
  --from-file=monitoring/grafana/provisioning/datasources/datasources.yml \
  --dry-run=client -o yaml | kubectl apply -f -
kubectl create configmap grafana-dashboards-provider -n invos \
  --from-file=monitoring/grafana/provisioning/dashboards/dashboards.yml \
  --dry-run=client -o yaml | kubectl apply -f -
kubectl create configmap grafana-dashboards -n invos \
  --from-file=monitoring/grafana/dashboards/ \
  --dry-run=client -o yaml | kubectl apply -f -
kubectl create configmap prometheus-config -n invos \
  --from-file=monitoring/prometheus/prometheus.yml \
  --dry-run=client -o yaml | kubectl apply -f -
```

## Autoscaling (Phase 2)

The whole point: the stress/scale profile drives the HPA, and pods grow then shrink.

### Pooling — why PgBouncer + `PG_POOL_MAX` matter

Scaling the app multiplies DB connections: each pod opens its own pg `Pool`. Two mitigations,
both applied:

- **`PG_POOL_MAX=5`** per pod (env in `ingest-deployment.yaml`, read by `server/src/db.js`).
- **PgBouncer** (transaction pooling) fans N app pods into a bounded set of server-side
  connections, so scaling raises throughput instead of exhausting Postgres' `max_connections`.

This moves the documented "p99 breaks ~400 req/s due to pg pool max:10" wall — a good
before/after talking point.

### Default scaling: CPU (`ingest-hpa.yaml`)

CPU utilization is the reliable baseline: each request is a 50-item batch that is JSON-parsed
+ Ajv-validated (real CPU work), so CPU tracks offered RPS. `requests.cpu: 150m` is modest on
purpose, so a few hundred req/s saturate a pod. Needs only **metrics-server**. Scale-down
stabilization is tuned to 30s so the shrink is watchable in one demo run.

### Opt-in scaling: custom requests/second metric

More on-message ("scale on the offered load itself") but adds the `custom.metrics.k8s.io`
API and more failure surface. Apply **one** HPA, not both:

```bash
kubectl delete hpa invos-ingest -n invos --ignore-not-found   # drop the CPU HPA
kubectl apply -f k8s/prometheus-adapter.yaml                   # custom-metrics backend
kubectl apply -f k8s/ingest-hpa-custom.yaml                    # RPS-based HPA

# verify the metric is being served:
kubectl get --raw "/apis/custom.metrics.k8s.io/v1beta1/namespaces/invos/pods/*/invos_ingest_requests_per_second" | jq .
```

### Watch it

```bash
kubectl get hpa,pods -n invos -w
```

…and the Grafana **System Performance → "Autoscaling — replicas vs offered load vs p99"**
panel overlays replica count, k6 offered load, and p99 on one time axis.

## Networking / gotchas

- Host k6 reaches the API at `localhost:8473` and remote-writes metrics to
  `localhost:9090`, both via kind's `extraPortMappings` (see `kind-config.yaml`). Prometheus
  now scrapes **inside** the cluster, so the old ufw bridge→host scrape issue is gone — but
  the host↔cluster hops (k6 → NodePort, k6 remote-write → Prometheus NodePort) are the new
  things to verify if metrics look missing.
- Rebuilt the image? You must `kind load docker-image invos-ingest:dev --name invos` again —
  a stale image is the classic "my fix didn't apply" trap. `run.sh up` always does this.
