# monitoring — Prometheus & Grafana

Provisioning-as-code for the observability stack. These files are the **single source of
truth** for both the primary Kubernetes path and the deprecated compose path:

- **Kubernetes (primary):** `scripts/run.sh up` loads `prometheus/prometheus.yml`, the Grafana
  provisioning, and the dashboard JSON into ConfigMaps and mounts them into the in-cluster
  Prometheus/Grafana (see `k8s/`). `prometheus.yml` uses **Kubernetes service-discovery** to
  scrape the autoscaled ingest pods.
- **Compose (deprecated):** `docker compose up -d` starts Prometheus and Grafana and
  auto-loads everything here, scraping the host server via `host.docker.internal`. Kept for one
  release; the legacy scrape config is preserved as a comment at the bottom of `prometheus.yml`.

```
monitoring/
├── prometheus/
│   └── prometheus.yml                       # scrape Fastify /metrics every 5s; remote-write on
└── grafana/
    ├── provisioning/
    │   ├── datasources/datasources.yml      # Prometheus + PostgreSQL datasources (fixed uids)
    │   └── dashboards/dashboards.yml         # dashboard provider -> loads the folder below
    └── dashboards/
        ├── system-performance.json           # Prometheus datasource: service health + k6 load
        └── invoice-analytics.json            # PostgreSQL datasource: the business data
```

## Access

- **Grafana** — http://localhost:8474 (host 8474 → container 3000). Anonymous viewer access is
  on (local demo); admin login is `admin` / `${GRAFANA_ADMIN_PASSWORD:-admin}` for editing.
- **Prometheus** — http://localhost:9090.

## How the pieces connect

- **Kubernetes:** Prometheus runs in-cluster and uses Kubernetes service-discovery to scrape
  every pod labelled `app=invos-ingest` at `:8473/metrics`, plus `kube-state-metrics:8080` for
  replica/HPA timeseries. The NodePort `localhost:9090` exists for k6 remote-write.
- **Compose (deprecated):** Prometheus scrapes the **host** Fastify server at
  `host.docker.internal:8473/metrics` (`extra_hosts: host-gateway`).
- Prometheus runs with `--web.enable-remote-write-receiver`, so a k6 run started with
  `-o experimental-prometheus-rw` (see `loadtest/`) pushes its metrics in live (`K6_PROM=1`).
- Grafana datasources use **fixed uids** (`prometheus`, `postgres`) so the committed dashboard
  JSON references them without per-machine editing. The datasource URLs (`http://prometheus:9090`,
  `postgres:5432`) match both the compose service names and the in-cluster Service names, so the
  same files work verbatim on both paths. The Postgres datasource is read-only by intent.

## Networking caveats

- **Grafana port.** Grafana is on `localhost:8474` (kind NodePort `30848`; compose host 8474 →
  container 3000, overridable with `GRAFANA_PORT`).
- **Kubernetes host↔cluster hops.** Prometheus now scrapes inside the cluster, so the old ufw
  bridge→host issue is gone for the K8s path. What to verify if metrics look missing: host k6 →
  NodePort `localhost:8473`, and host k6 remote-write → Prometheus NodePort `localhost:9090`.
- **Firewall (ufw) — compose path only.** There, Prometheus scrapes the host via
  `host.docker.internal`; with ufw the Docker bridge → host packets may be dropped, leaving the
  `fastify-ingest` target `down`. Fix: `sudo ufw allow in on docker0 to any port 8473`
  (adjust the bridge name). The k6 remote-write path (host → `localhost:9090`) is unaffected.

## Dashboards

**System Performance** (Prometheus): ingest request rate by status, latency p50/p95/p99 from
the `invos_ingest_duration_seconds` histogram, invoice outcome rates (created/duplicate/
rejected), Node event-loop lag / heap / CPU, a panel overlaying **k6 offered load** with
the **server-observed** rate — the visual proof of open-model load testing — and the
**Autoscaling — replicas vs offered load vs p99** panel (replica count from
kube-state-metrics overlaid on offered load and p99), the visual proof that traffic drives the
HPA to grow and shrink pods. Run `bash scripts/run.sh scale` to watch it.

**Invoice Analytics** (PostgreSQL): a live view of the ingested data. Total invoices / line
items / revenue tick up as rows arrive; **invoices ingested per 5s** and a **cumulative** line
show the database filling from empty (by `created_at`, ingest time); and **line items by
commodity type** shows the generic commodity mix growing. A **user-analytics** row tracks
distinct consumers by `carrier_id` — distinct users, average invoices per user, identified
share, new users per 5s, and top users by spend. Start with an empty DB
(`bash scripts/run.sh up` does not replay) and run a test to watch it fill.

The default time range is relative (`now-15m → now`) with 5s auto-refresh, so the live ingest
is visible without adjusting the picker.

## Editing dashboards

The dashboard provider re-reads the folder every 10 s and `allowUiUpdates` is on, so you can
tweak a panel in the Grafana UI, then export the JSON (Dashboard settings → JSON Model) back
into `dashboards/` to keep it in git.
