# monitoring — Prometheus & Grafana (Step 5)

Provisioning-as-code for the observability stack. `docker compose up -d` starts Prometheus
and Grafana and auto-loads everything here — no manual clicking in the Grafana UI.

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

- **Grafana** — http://localhost:3001 (host 3001 → container 3000). Anonymous viewer access is
  on (local demo); admin login is `admin` / `${GRAFANA_ADMIN_PASSWORD:-admin}` for editing.
- **Prometheus** — http://localhost:9090.

## How the pieces connect

- Prometheus scrapes the **host** Fastify server at `host.docker.internal:8473/metrics` every
  5 s (the server runs on the host, not in compose; `extra_hosts: host-gateway` makes the host
  reachable from the container on Linux).
- Prometheus runs with `--web.enable-remote-write-receiver`, so a k6 run started with
  `-o experimental-prometheus-rw` (see `loadtest/`) pushes its metrics in live.
- Grafana datasources use **fixed uids** (`prometheus`, `postgres`) so the committed dashboard
  JSON references them without per-machine editing. The Postgres datasource uses the demo-only
  credentials from `docker-compose.yml` and is read-only by intent (dashboards only `SELECT`).

## Host networking caveats

- **Grafana port.** Grafana publishes host `3001`. If that port is busy, set `GRAFANA_PORT`:
  `GRAFANA_PORT=3002 docker compose up -d grafana` (then browse to `:3002`).
- **Linux + firewall (ufw).** Prometheus scrapes the host server via `host.docker.internal`.
  On macOS (the primary target) this works out of the box. On Linux with a restrictive firewall
  (e.g. ufw), the Docker bridge → host packets may be dropped, leaving the `fastify-ingest`
  target `down` with a timeout. Two fixes: allow the Docker subnet to reach the host
  (`sudo ufw allow in on docker0 to any port 8473`, adjusting the bridge name), or run the
  server bound to the host on all interfaces (it already binds `0.0.0.0:8473`) and confirm the
  firewall isn't blocking it. The k6 remote-write path (host → `localhost:9090`) is unaffected.

## Dashboards

**System Performance** (Prometheus): ingest request rate by status, latency p50/p95/p99 from
the `invos_ingest_duration_seconds` histogram, invoice outcome rates (created/duplicate/
rejected), Node event-loop lag / heap / CPU, and a panel overlaying **k6 offered load** with
the **server-observed** rate — the visual proof of open-model load testing.

**Invoice Analytics** (PostgreSQL): daily invoice count & revenue, top categories by quantity,
average invoices per day-of-week (the generator's weekend lift), and **toothpaste daily
quantity by brand** — with the Step-2 campaign enabled, the **PearlGuard** line lifts after the
campaign start day (2025-02-15). Every panel queries by `invoice_date` (event/simulated time),
**not** `created_at` (ingest time) — event-time vs processing-time is a deliberate distinction.

The default time range is fixed to the generator's 90-day window (2025-01-01 → 2025-04-01) so
the historical data is visible without adjusting the picker.

## Editing dashboards

The dashboard provider re-reads the folder every 10 s and `allowUiUpdates` is on, so you can
tweak a panel in the Grafana UI, then export the JSON (Dashboard settings → JSON Model) back
into `dashboards/` to keep it in git.
