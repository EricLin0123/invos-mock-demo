# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A small Fastify service that ingests mock Taiwanese e-invoice data into PostgreSQL,
built to be **load-tested**. Four cooperating parts:

- `generator/` — Python 3.12 (managed by `uv`) that writes deterministic mock invoices as
  **NDJSON only** (no DB, no network).
- `server/` — Node 20 + Fastify ingestion API on host `:8473`, validates and idempotently
  persists invoices, exposes Prometheus metrics at `/metrics`.
- `loadtest/` — four k6 profiles (smoke / load / stress / soak) driving the API.
- `monitoring/` — Prometheus + Grafana, provisioned as code.

The DB (Postgres 16), Prometheus, and Grafana run in Docker Compose; **the server runs on
the host**, not in compose. Compose reaches it via `host.docker.internal` (`extra_hosts:
host-gateway`).

## Commands

`scripts/run.sh` is the one-command path; it brings up compose, migrates, generates data,
starts the server, and prepares the k6 feed. **`up` starts with an empty DB — it does not
replay.** The k6 tests are what populate the DB.

```bash
bash scripts/run.sh up        # stack + migrate + generate + start server (empty DB)
bash scripts/run.sh smoke     # 5 req/s, ~1 min
bash scripts/run.sh load      # ramp 0->100 req/s, hold 10 min
bash scripts/run.sh stress    # step 100->800 req/s until a threshold breaks
bash scripts/run.sh soak      # 50 req/s, 60 min
bash scripts/run.sh down      # stop everything; WIPE_DATA=1 also drops data volumes
```

`up` knobs: `COUNT` (invoices to generate, default 100000), `SEED` (default 42).

Lower-level entry points:

```bash
# server (run from server/)
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
make k6-smoke | k6-load | k6-stress | k6-soak    # set K6_PROM=1 to push metrics to Prometheus
make k6-verify                                   # post-run DB consistency checks (loadtest/verify.sql)
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
  breaks first near ~400 req/s; suspected bottleneck is the default pg pool `max: 10`).

- **Generator ↔ live traffic split.** The generator dates every invoice **today** and the k6
  layer **re-stamps `invoice_number` and `invoice_date` at emit time** (`loadtest/lib/payloads.js`,
  `uniqueInvoiceNumber()`), so every healthy POST is a real insert and you watch the DB fill
  live from empty. Without unique re-stamping, a finite pool + `ON CONFLICT DO NOTHING` makes
  the insert rate decay exponentially (this was a real soak-test bug). Consequence: soak makes
  the DB grow unbounded — reset with `WIPE_DATA=1 bash scripts/run.sh down`.

- **Metrics.** Custom Prometheus metrics live in `server/src/metrics.js`:
  `invos_ingest_requests_total{route,status}`, `invos_ingest_invoices_total{result}`
  (created|duplicate|rejected), `invos_ingest_duration_seconds` (histogram). Grafana has two
  dashboards: **System Performance** (Prometheus — service health + k6 load) and **Invoice
  Analytics** (Postgres — business data, including user analytics keyed on `carrier_id`).

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
  (`invos` / `devonly` / `invoices`, port 5432) — see `server/src/db.js`.
- **ufw firewall:** Prometheus scrapes the host server via `host.docker.internal`; with ufw
  enabled, bridge→host packets may be dropped, leaving the scrape target `down`. See
  `monitoring/README.md` for the allow rule.
- Prometheus runs with `--web.enable-remote-write-receiver` so `K6_PROM=1` (k6
  `-o experimental-prometheus-rw`) can push metrics live.
