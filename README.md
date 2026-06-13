# invos-mock-demo

A small demo project that ingests mock Taiwanese e-invoice data into a local PostgreSQL
database for testing and development. It is built up in five steps and this repo implements
**all of them**: a Fastify server on Dockerized PostgreSQL 16 (Step 1), a Python data
generator that emits mock invoices as NDJSON with a built-in ad-campaign effect (Step 2), an
ingestion API that validates and persists invoices idempotently while exposing Prometheus
metrics (Step 3), a Grafana k6 load test that replays the data under smoke/load/stress/soak
profiles (Step 4), and a provisioned Prometheus + Grafana monitoring stack with two
dashboards-as-code (Step 5).

## Architecture

```mermaid
flowchart LR
  gen["generator (Python)\nmock invoices + ad campaign"] -->|NDJSON| feed
  subgraph feed["traffic"]
    replay["server/scripts/replay.js"]
    k6["k6 profiles\n(smoke/load/stress/soak)"]
  end
  feed -->|"POST /api/invoices(/batch)"| api["Fastify ingestion API\n:8473  /metrics"]
  api -->|"idempotent upsert"| pg[("PostgreSQL 16")]
  prom["Prometheus :9090"] -->|"scrape /metrics 5s"| api
  k6 -.->|"remote-write (optional)"| prom
  graf["Grafana :8474"] -->|PromQL| prom
  graf -->|SQL| pg
```

Prometheus and Grafana observe **both sides**: the service (via `/metrics`) and the data (via
SQL). k6 can push its own metrics to Prometheus so offered load and server-observed load sit on
one chart — the visual proof of open-model load testing.

## Fast path

If you just want to see it work, the one-liner does the whole pipeline (compose up → migrate →
generate → replay → k6 → print URLs):

```bash
bash scripts/demo.sh          # smoke profile (~1 min of k6)
```

Then open **Grafana at http://localhost:8474**. Knobs: `K6_PROFILE=load`, `SKIP_K6=1`,
`SEED=42` (see `scripts/README.md`). Everything below is the same pipeline done by hand, one step
at a time, so you can see and verify each piece.

## In-depth step-by-step guide

This walks the full project the way it was built in `steps/`: **generate → migrate → serve →
ingest → load-test → monitor**. Run every command from the repo root unless noted.

### Prerequisites

Put these four tools on your `PATH` (commands below are for Debian/Ubuntu):

| Tool | Used for | Install (Debian/Ubuntu) |
| --- | --- | --- |
| **Docker Engine** + Compose plugin | Postgres, Prometheus, Grafana | [official apt repo](https://docs.docker.com/engine/install/ubuntu/) (`docker.io` also works for the demo) |
| **Node.js 20** | the Fastify server, replay & migrate scripts | [NodeSource](https://github.com/nodesource/distributions) (`apt install nodejs`) |
| **uv** | the Python 3.12 data generator | `curl -LsSf https://astral.sh/uv/install.sh \| sh` |
| **k6** | load testing (Step 4) | [Grafana apt repo](https://grafana.com/docs/k6/latest/set-up/install-k6/#linux) or download the binary |

Verify: `docker --version && node --version && uv --version && k6 version`.

> **Firewall note (ufw).** The monitoring stack scrapes the server on the *host* via
> `host.docker.internal`. With `ufw` enabled, bridge→host packets may be dropped, leaving the
> scrape target `down`. See `monitoring/README.md` for the one-line `ufw` allow rule.

### Step 1 — Start PostgreSQL and migrate the schema

```bash
# Bring up only Postgres for now (Prometheus + Grafana come in Step 5).
docker compose up -d postgres
docker compose ps                                 # wait until postgres is "healthy"

# Install server deps and apply db/migrations/*.sql (idempotent — safe to re-run).
cd server && npm install && npm run migrate
cd ..
```

The compose Postgres uses demo-only credentials (`invos` / `devonly`, db `invoices`) on
`localhost:5432`, matching the server's config defaults.

### Step 2 — Generate the mock invoice data

```bash
cd generator
uv sync                                           # creates generator/.venv from pyproject.toml
uv run python -m generator --seed 42 --out data/invoices_90d.ndjson
cd ..
```

This writes a deterministic, date-sorted NDJSON file (~90 days × 5,000 households, ≈98k
invoices) plus `data/ground_truth.json` recording which households the ad campaign exposed.
Same `--seed` + `config.yaml` ⇒ byte-identical output. Both files are git-ignored. Tune behavior
in `generator/config.yaml` (e.g. set `campaign.enabled: false` to remove the toothpaste lift).

### Step 3 — Start the ingestion server and replay the data

```bash
# Start the Fastify ingestion API on the HOST (port 8473). Backgrounded so you can keep typing;
# running on the host is what lets Prometheus scrape it in Step 5.
cd server && npm run start &
curl localhost:8473/healthz                        # -> {"status":"ok","db":true}

# Replay the generated NDJSON through POST /api/invoices/batch.
npm run replay -- ../generator/data/invoices_90d.ndjson
# -> { sent, created, duplicates, rejected, elapsed_s, db_invoices, db_items }
cd ..
```

Replaying the same file a second time reports **100% duplicates** with unchanged row counts —
the `ON CONFLICT DO NOTHING` idempotency in action. Inspect the read-back aggregates and metrics:

```bash
curl "localhost:8473/api/stats/daily?from=2025-01-01&to=2025-01-03"
curl "localhost:8473/api/stats/category-daily?category=toothpaste"
curl localhost:8473/metrics                        # Prometheus metrics
```

Run the test suite any time (needs the compose Postgres up and migrated):

```bash
cd server && npm test && cd ..
```

### Step 4 — Load test with k6

k6 replays the generated invoices in batches of 50, injecting ~2% malformed payloads (asserting
4xx, never 5xx) and enforcing latency/error thresholds. The data feed is prepared once from the
NDJSON (the Makefile does this automatically on first run):

```bash
make k6-smoke    # 5 req/s, 1 min — quick correctness check
make k6-load     # ramp 0->100 req/s, hold 10 min
make k6-stress   # step 100->200->400->800 req/s until a threshold breaks
make k6-soak     # 50 req/s, 60 min
make k6-verify   # DB consistency checks after a run (loadtest/verify.sql)
```

To push k6's own metrics into Prometheus for the live overlay (Step 5), set `K6_PROM=1`:
`K6_PROM=1 make k6-load`. See `loadtest/README.md` for thresholds, env vars, and the documented
stress failure point.

### Step 5 — Bring up monitoring (Prometheus + Grafana)

```bash
docker compose up -d                               # adds prometheus (:9090) and grafana (:8474)
```

Both are provisioned as code from `monitoring/` — datasources and two dashboards auto-load with
zero clicking. Open **http://localhost:8474** (anonymous viewer; admin login `admin` /
`${GRAFANA_ADMIN_PASSWORD:-admin}` to edit). If port 8474 is taken, override it:
`GRAFANA_PORT=8475 docker compose up -d grafana`.

- **System Performance** (Prometheus): request rate by status, latency p50/p95/p99, invoice
  outcome rates, Node event-loop/heap/CPU, and **k6 offered load vs server-observed rate**. Run
  `K6_PROM=1 make k6-load` and watch the traffic appear live.
- **Invoice Analytics** (PostgreSQL): daily counts & revenue, top categories, weekend lift, and
  **toothpaste daily quantity by brand** — with the campaign on, the **PearlGuard** line visibly
  lifts after **2025-02-15**.

See the [Monitoring](#monitoring-step-5--prometheus--grafana) section below for dashboard details
and `monitoring/README.md` for the host-networking specifics. When you're done, see
[Cleanup](#cleanup).

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

See `loadtest/README.md` for design notes, env vars, the optional Prometheus output, and the
documented **stress failure point**. The k6 data feed (`loadtest/data/chunks.json`) is
generated and git-ignored.

## Monitoring (Step 5 — Prometheus + Grafana)

`docker compose up -d` brings up Prometheus (`:9090`) and Grafana (`:8474`), both provisioned
as code from `monitoring/` — datasources and two dashboards auto-load with zero manual clicks:

- **System Performance** (Prometheus): request rate by status, latency p50/p95/p99, invoice
  outcome rates, Node event-loop/heap/CPU, and **k6 offered load vs server-observed rate**.
- **Invoice Analytics** (PostgreSQL): daily counts & revenue, top categories, weekend lift,
  and **toothpaste daily quantity by brand** — with the campaign on, the **PearlGuard** line
  visibly lifts after **2025-02-15**; turn `campaign.enabled: false` in the generator config and
  it stays flat. All panels query by `invoice_date` (event time), not `created_at` (ingest time).

Grafana is at http://localhost:8474 (anonymous viewer; admin `admin`/`${GRAFANA_ADMIN_PASSWORD:-admin}`).
If port 8474 is taken, set `GRAFANA_PORT`. See `monitoring/README.md` for details (including a
Linux/ufw firewall note for the host scrape). Screenshots:

<!-- ![System Performance dashboard](docs/system-performance.png) -->
<!-- ![Invoice Analytics dashboard](docs/invoice-analytics.png) -->

## Design notes

- **Idempotent ingest.** `ON CONFLICT (invoice_number, invoice_date) DO NOTHING` makes replays
  and retries safe; duplicates are a tracked metric, not an error.
- **Open-model load.** k6 uses arrival-rate executors, so a slowing server shows up as broken
  latency thresholds — not as silently reduced load. The system dashboard overlays k6's offered
  rate with the server-observed rate to make this visible.
- **Event-time analytics.** Dashboards aggregate by `invoice_date` (when the purchase happened),
  not `created_at` (when we ingested it) — the event-time vs processing-time distinction.
- **Campaign ground truth.** The generator embeds a known ad-campaign effect and records exactly
  who was exposed in `generator/data/ground_truth.json`, so the dashboard's detected lift can be
  checked against the truth.

## Stack

- Node.js 20 + Fastify (`server/`)
- Grafana k6 load test (`loadtest/`)
- Prometheus + Grafana, provisioned as code (`monitoring/`)
- PostgreSQL 16 via Docker Compose (`docker-compose.yml`)
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

## Future work (out of scope)

No Kubernetes (stays on Docker Compose), no Grafana alerting rules, and no auth hardening —
the stack uses demo-only credentials and anonymous Grafana access on purpose.

## Cleanup

Return the machine to a pristine state:

```bash
# Stop every process the demo started (host server, k6) and tear down the compose stack.
WIPE_DATA=1 bash scripts/stop-demo.sh   # add WIPE_DATA=1 to also drop the data volumes

# Reclaim space from pulled images/build cache
docker system prune -f

# Remove the repo
cd .. && rm -rf invos-mock-demo

# Uninstall the toolchain (Debian/Ubuntu)
sudo apt-get remove --purge nodejs k6 && sudo apt-get autoremove   # if installed via apt
uv self uninstall                                                  # removes the uv binary
# Docker Engine: sudo apt-get remove --purge docker-ce docker-ce-cli containerd.io
```

> The build steps are described in `steps/`. Feed them one at a time, in order, verifying each
> step's acceptance criteria before starting the next.
