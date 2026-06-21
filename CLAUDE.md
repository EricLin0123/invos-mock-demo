# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A small Fastify service that ingests mock Taiwanese e-invoice data into PostgreSQL,
built to be **load-tested** and **horizontally autoscaled on Kubernetes**. Four cooperating
parts:

- `generator/` — Python 3.12 (managed by `uv`) that writes deterministic mock invoices as
  **NDJSON only** (no DB, no network).
- `server/` — Node 20 + Fastify ingestion API on `:8473`, validates and idempotently
  persists invoices, exposes Prometheus metrics at `/metrics`. Containerized (`server/Dockerfile`).
- `loadtest/` — five k6 profiles (smoke / load / stress / scale / soak) driving the API.
- `monitoring/` — Prometheus + Grafana, provisioned as code.
- `k8s/` — kustomize manifests for the whole stack on a local **kind** cluster (see `k8s/README.md`).

**Everything runs inside a local Kubernetes (kind) cluster** in namespace `invos`: the ingest
API as a scalable `Deployment` behind an HPA, Postgres as a single-replica `StatefulSet`
(+ PgBouncer), Prometheus (Kubernetes service-discovery), Grafana, kube-state-metrics, and
metrics-server. **There is no host-run server anymore.** k6 stays on the host and targets the
kind NodePort (`localhost:8473`). `kind-config.yaml` (repo root) maps NodePorts → localhost
(8473 ingest, 8474 Grafana, 9090 Prometheus). The old `docker-compose.yml` + host-server path
is **deprecated**, kept only as a one-release fallback.

## Commands

`scripts/run.sh` is the one-command path; on `up` it creates the kind cluster, builds and
`kind load`s the server image, installs metrics-server, applies `k8s/` (plus ConfigMaps
generated from `monitoring/`), runs the migrate Job, generates data, and prepares the k6 feed.
**`up` starts with an empty DB — it does not replay.** The k6 tests are what populate the DB.

```bash
bash scripts/run.sh up        # kind cluster + image + manifests + migrate + generate (empty DB)
bash scripts/run.sh smoke     # 5 req/s, ~1 min
bash scripts/run.sh load      # ramp 0->100 req/s, hold 10 min
bash scripts/run.sh stress    # step 100->800 req/s until a threshold breaks
bash scripts/run.sh scale     # ramp UP then DOWN — drives the HPA so pods grow then shrink
bash scripts/run.sh soak      # 50 req/s, 60 min
bash scripts/run.sh down      # delete the cluster (WIPE_DATA=1 too — the PVC goes with it)
```

`up` knobs: `COUNT` (invoices, default 100000), `SEED` (default 42), `CLUSTER` (kind name,
default `invos`), `IMAGE` (server tag, default `invos-ingest:dev`).

Watch autoscaling: `kubectl get hpa,pods -n invos -w`, plus the Grafana "Autoscaling" panel.

Lower-level entry points:

```bash
# image (build from repo ROOT so db/migrations is included), then load into kind
docker build -f server/Dockerfile -t invos-ingest:dev . && kind load docker-image invos-ingest:dev --name invos

# server (run from server/; local dev outside the cluster)
npm run migrate        # apply db/migrations/*.sql in filename order
npm run start          # ingestion API on :8473
npm run dev            # same, with --watch
npm test               # node --test (test/*.test.js)
node --test test/invoices.test.js   # a single test file

# generator (run from generator/)
uv run python -m generator --seed 42 --count 100000 --out data/invoices_90d.ndjson
uv run --extra test pytest                       # all generator tests
uv run --extra test pytest tests/test_generator.py::test_totals_add_up   # one test

# k6 (from repo root; targets cd into loadtest/ so open() resolves the data file)
make k6-smoke | k6-load | k6-stress | k6-scale | k6-soak  # set K6_PROM=1 to push metrics to Prometheus
make k6-verify                                   # post-run DB checks via `kubectl exec` into the Postgres pod
```

Grafana: http://localhost:8474 · Prometheus: http://localhost:9090.

## Architecture notes that span files

- **Idempotency is the core design choice.** The natural key is
  `(invoice_number, invoice_date)` (Taiwanese invoice numbers are only unique within a
  bimonthly period). Inserts use `ON CONFLICT (invoice_number, invoice_date) DO NOTHING`
  (`server/src/ingest.js`), so replays/retries are safe and duplicates are a tracked metric,
  not an error. The surrogate PK is `id BIGSERIAL`; ingest time is `created_at` (used by the
  analytics dashboard's time charts).

- **Two validators on purpose.** The single endpoint uses Fastify's own Ajv; the batch
  endpoint compiles a standalone Ajv (`ingest.js`) so it can do per-item partial success
  instead of one 400 for the whole body. Fastify is configured with `removeAdditional: false`
  (`server/src/app.js`) so unknown fields are *rejected*, not silently stripped. There is also
  a server-side consistency gate (`consistencyError`): `total_amount` must equal
  `Σ items.amount`, else **422**.

- **Open-model load testing.** All k6 profiles use arrival-rate executors, so a slowing
  server shows as **broken thresholds**, not silently reduced load. Healthy invoices go to
  `POST /api/invoices/batch` (tagged `expected:ok`); ~2% malformed payloads go to
  `POST /api/invoices` (tagged `expected:reject`, asserting 4xx and never 5xx). See
  `loadtest/README.md` for thresholds and the documented stress failure point (p99 tail
  breaks first near ~400 req/s; suspected bottleneck was the default pg pool `max: 10`). On
  K8s this bottleneck is **moved**: per-pod `PG_POOL_MAX=5` + PgBouncer let the autoscaled
  fleet raise throughput instead of exhausting Postgres. The new **`scale`** profile ramps up
  *and back down* (no `abortOnFail`) to exercise HPA grow/shrink, vs. `stress` which aborts at
  the wall.

- **Autoscaling (K8s).** The ingest `Deployment` has an HPA (`k8s/ingest-hpa.yaml`, CPU
  utilization by default; opt-in custom requests/second via `prometheus-adapter.yaml` +
  `ingest-hpa-custom.yaml` — apply only one HPA). `requests.cpu: 150m` is deliberately small so
  a few hundred req/s saturate a pod and force scale-out; scale-down stabilization is tuned to
  30s so the shrink is watchable. **Resource requests are mandatory** for CPU HPA. See
  `k8s/README.md`.

- **Generator ↔ live traffic split.** The generator dates every invoice **today** and the k6
  layer **re-stamps `invoice_number` and `invoice_date` at emit time** (`loadtest/lib/payloads.js`,
  `uniqueInvoiceNumber()`), so every healthy POST is a real insert and you watch the DB fill
  live from empty. Without unique re-stamping, a finite pool + `ON CONFLICT DO NOTHING` makes
  the insert rate decay exponentially (this was a real soak-test bug). Consequence: soak makes
  the DB grow unbounded — reset with `WIPE_DATA=1 bash scripts/run.sh down`.

- **Metrics.** Custom Prometheus metrics live in `server/src/metrics.js`:
  `invos_ingest_requests_total{route,status}`, `invos_ingest_invoices_total{result}`
  (created|duplicate|rejected), `invos_ingest_duration_seconds` (histogram). Grafana has two
  dashboards: **System Performance** (Prometheus — service health + k6 load, now incl. the
  **Autoscaling — replicas vs offered load vs p99** panel fed by kube-state-metrics) and
  **Invoice Analytics** (Postgres — business data, including user analytics keyed on `carrier_id`).

- **Known schema drift:** the DB (`db/migrations/001_init.sql`) and `insertInvoice` still
  carry a nullable `brand` column on items, but the simplified generator no longer emits
  `brand`. Items insert `brand` as NULL. Leave it unless asked to clean up.

## Repo conventions (enforced)

- If you add a subfolder one level down from the project root, add a `README.md` in it
  describing what the code there is and how to use it.
- If any code generates or caches data, add `.gitignore` rules so the generated/cached
  artifacts are never committed (e.g. `generator/data/`, `loadtest/data/chunks.json`).

## Environment / gotchas

- Server DB config: `DATABASE_URL` takes precedence, else `PG*` vars with localhost defaults
  (`invos` / `devonly` / `invoices`, port 5432) — see `server/src/db.js`. `PG_POOL_MAX`
  (default 10) caps the per-process pool; on K8s it is set to 5 per pod.
- **kind image loading:** rebuilding the server image requires
  `kind load docker-image invos-ingest:dev --name invos` before pods pick it up — a stale
  image is the classic "my fix didn't apply" trap. `run.sh up` always does this. The image
  must be built from the **repo root** (`-f server/Dockerfile .`) so it carries `db/migrations`.
- **Prometheus scrape is now in-cluster** (Kubernetes SD over pods labelled `app=invos-ingest`),
  so the old ufw `host.docker.internal` bridge→host issue is gone. The host↔cluster hops to
  verify instead are k6 → NodePort `localhost:8473` and k6 remote-write → `localhost:9090`.
  (The ufw note still applies to the deprecated compose path; see `monitoring/README.md`.)
- Prometheus runs with `--web.enable-remote-write-receiver` so `K6_PROM=1` (k6
  `-o experimental-prometheus-rw`) can push metrics live.
