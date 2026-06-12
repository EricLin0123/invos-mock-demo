# invos-mock-demo

A small demo project that ingests mock Taiwanese e-invoice data into a local PostgreSQL
database for testing and development. It is built up in five steps (server & database, data
generation, ingestion, k6 load testing, Grafana monitoring); this repo currently implements
**Steps 1–4** — a Fastify server connected to a Dockerized PostgreSQL 16, a Python data
generator that emits mock invoices as NDJSON, an ingestion API that validates and persists
those invoices idempotently while exposing Prometheus metrics, and a Grafana k6 load test
(`loadtest/`) that replays the generated data under smoke/load/stress/soak profiles.

## Quickstart (end to end: generate → migrate → serve → replay → query)

```bash
# 0. Postgres
docker compose up -d postgres

# 1. Generate mock invoices (Step 2) — writes generator/data/invoices_90d.ndjson
cd generator && uv sync && uv run python -m generator --seed 42 --out data/invoices_90d.ndjson
cd ..

# 2. Migrate the schema and start the ingestion server (Step 1 + 3)
cd server && npm install && npm run migrate && npm run start &
curl localhost:8473/healthz                       # -> {"status":"ok","db":true}

# 3. Replay the generated file into the API (Step 3)
npm run replay -- ../generator/data/invoices_90d.ndjson
# -> { sent, created, duplicates, rejected, elapsed_s, db_invoices, db_items }
# Replaying again reports 100% duplicates and leaves the row counts unchanged (idempotent).

# 4. Query the read-back aggregates
curl "localhost:8473/api/stats/daily?from=2025-01-01&to=2025-01-03"
curl "localhost:8473/api/stats/category-daily?category=toothpaste"
curl localhost:8473/metrics                       # Prometheus metrics
```

## API (Step 3 — ingestion)

| Method & path | Purpose |
| --- | --- |
| `POST /api/invoices` | Ingest one invoice. `201 {status:"created", id}` on a fresh insert, `200 {status:"duplicate"}` if it already exists, `400` on schema failure, `422` if `total_amount` ≠ Σ item amounts. |
| `POST /api/invoices/batch` | Ingest up to 500 invoices in one transaction. Returns `{created, duplicates, rejected:[{index, reason}]}`; validation rejects are partial-success, a DB error rolls the whole batch back. |
| `GET /api/stats/daily?from&to` | Daily `{day, invoice_count, total_amount}`. |
| `GET /api/stats/category-daily?category=&from&to` | Daily `{day, category, quantity, amount}`. |
| `GET /metrics` | Prometheus metrics: `invos_ingest_requests_total`, `invos_ingest_invoices_total`, `invos_ingest_duration_seconds`, plus default Node process metrics. |
| `GET /healthz` | DB connectivity check. |

Validation is enforced with Fastify's built-in JSON Schema (strict: unknown fields are
rejected). Idempotency comes from an `ON CONFLICT (invoice_number, invoice_date) DO NOTHING`
insert — the natural key, since Taiwanese invoice numbers are only unique per bimonthly period.

**Measured locally:** the default 90-day file (98,060 invoices / 343,054 items) replays in
~13 s; p95 single-invoice insert latency is well under 5 ms at concurrency 8 (target ~20 ms).

## Load testing (Step 4 — k6)

`loadtest/` drives the ingestion API with [Grafana k6](https://k6.io). It replays the
generated invoices in batches of 50 against `POST /api/invoices/batch`, injects 2% malformed
payloads (asserting 400/422, never 5xx), enforces latency/error thresholds, and reports custom
counters (`invos_created`, `invos_duplicates`, `invos_rejected`). Four profiles — smoke, load,
stress, soak — are wired to Makefile targets:

```bash
make k6-smoke    # 5 req/s, 1 min
make k6-load     # ramp 0->100 req/s, hold 10 min
make k6-stress   # step 100->200->400->800 req/s until a threshold breaks
make k6-soak     # 50 req/s, 60 min
make k6-verify   # DB consistency checks after a run (loadtest/verify.sql)
```

See `loadtest/README.md` for design notes, env vars, and the optional Prometheus output
(Step 5). The k6 data feed (`loadtest/data/chunks.json`) is generated and git-ignored.

## Stack

- Node.js 20 + Fastify (`server/`)
- Grafana k6 load test (`loadtest/`)
- PostgreSQL 16 via Docker Compose / OrbStack (`docker-compose.yml`)
- Plain SQL migrations with a tiny runner (`db/migrations/`, `server/scripts/migrate.js`)
- Prometheus client (`prom-client`) for ingestion metrics
- Python 3.12 + Faker data generator (`generator/`, managed by `uv`)

## Configuration

The server reads `DATABASE_URL`, or falls back to `PGHOST` / `PGPORT` / `PGUSER` /
`PGPASSWORD` / `PGDATABASE` with localhost demo defaults that match `docker-compose.yml`.

## Tests

```bash
cd server && npm test   # requires the compose Postgres to be running and migrated
```

> The build steps are described in `steps/`. Feed them one at a time, in order, verifying each
> step's acceptance criteria before starting the next.
