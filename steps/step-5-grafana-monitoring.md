# invos-mock-demo — Step 5: Grafana Dashboards & Monitoring

## Context

Final step. The stack ingests generated invoices (Steps 1–3) and k6 drives load with optional Prometheus remote-write (Step 4). Now add Prometheus + Grafana to Docker Compose and provision two dashboards as code: one for system performance, one for the invoice data itself — including making the Step-2 "ad campaign" effect visible on a chart.

## Goal of this step

`docker compose up -d` brings up the full stack; Grafana at `localhost:8474` auto-loads datasources and two dashboards with zero manual clicking. A k6 load run is visible live; the toothpaste campaign lift is visible in the business dashboard.

## Tasks

1. **Compose additions** (`docker-compose.yml`):
   - `prometheus` (port 9090): scrape config at `monitoring/prometheus/prometheus.yml` scraping the Fastify `/metrics` every 5 s; enable remote-write receiver (`--web.enable-remote-write-receiver`) so k6 can push.
   - `grafana` (host port 8474, container 3000): provisioned datasources (Prometheus + PostgreSQL, both read-only intent; Postgres datasource uses the demo credentials with a `# demo-only` comment) and dashboard auto-load from `monitoring/grafana/dashboards/`.
   - Anonymous viewer access enabled (it's a local demo); admin password via env default.
2. **Dashboard 1 — `system-performance.json`** (Prometheus datasource):
   - Ingest request rate by status (stacked), from `invos_ingest_requests_total`.
   - Latency p50/p95/p99 from `invos_ingest_duration_seconds` histogram.
   - Created vs duplicate vs rejected invoice rates (`invos_ingest_invoices_total`).
   - Node process panels: event loop lag, heap used, CPU.
   - k6 offered load (k6 remote-write metrics, e.g. `k6_http_reqs_total` rate) overlaid with server-observed rate — the visual proof of open-model load testing.
3. **Dashboard 2 — `invoice-analytics.json`** (PostgreSQL datasource, time-series + table panels with raw SQL — keep queries readable, they're interview exhibits):
   - Daily invoice count & total NTD amount (time series over `invoice_date`).
   - Top categories by quantity (bar/table).
   - **Toothpaste daily quantity by brand** (multi-series time series) — with the Step-2 campaign enabled, the campaign brand's line visibly lifts after the campaign start day; add a dashboard text panel explaining what to look for and referencing `ground_truth.json`.
   - Weekday vs weekend purchase pattern (bar by `EXTRACT(dow ...)`).
   - Important: panels query by `invoice_date` (simulated time), not `created_at` (ingest time) — add a comment in the dashboard JSON description; this distinction (event time vs processing time) is a deliberate talking point.
4. **Time handling**: dashboard 2's default time range must cover the generated date span (set fixed default range matching the generator's configured window, documented in README).
5. **End-to-end demo script** (`scripts/demo.sh`, annotated): compose up → migrate → generate (campaign on) → replay → run k6 load profile with Prometheus output → print Grafana URLs and what to observe. This is the "show the interviewer in 5 minutes" path.
6. **README final pass** (root): architecture diagram (mermaid: generator → k6/replay → Fastify → Postgres; Prometheus/Grafana observing both sides), quickstart, screenshot placeholders, and a short "design notes" section: idempotent ingest, open-model load, event-time analytics, campaign ground truth.
7. **Cleanup section** in README: `docker compose down -v`, `docker system prune -f`, `rm -rf` the repo, plus `brew uninstall` lines for the toolchain — the machine returns to pristine state.

## Acceptance criteria

- Fresh clone → `bash scripts/demo.sh` → both dashboards populated without any manual Grafana configuration.
- During a `make k6-load` run, system dashboard shows live traffic; thresholds from Step 4 still pass with monitoring enabled.
- With campaign enabled in the generator config, the campaign brand's toothpaste series shows a visible lift after the campaign start date; with `null` config (campaign off), it doesn't — verify both and note it in README.
- All provisioning is in git (datasources + dashboards as JSON/YAML); `docker compose down -v && up -d` reproduces everything.

## Out of scope

No kind/Kubernetes, no alerting rules, no auth hardening — list these as "future work" in the README instead.
