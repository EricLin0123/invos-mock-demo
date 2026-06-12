# loadtest — k6 load testing (Step 4)

k6 is the traffic engine for the ingestion API. It replays the Step-2 invoice data against
`POST /api/invoices/batch` under four controlled load shapes, deliberately mixes in malformed
payloads, and turns latency/error expectations into pass/fail **thresholds**. The results are
the load story Grafana visualizes in Step 5.

k6 is a standalone binary (`brew install k6`, or download from grafana.com/k6) — no extensions,
no k6 Cloud.

## Layout

```
loadtest/
├── prepare.js          # NDJSON -> data/chunks.json (one JSON array for SharedArray)
├── lib/
│   ├── payloads.js     # SharedArray pool, batch builder, malformed mutator, one iteration
│   └── checks.js       # custom counters + per-profile threshold factory
├── profiles/
│   ├── smoke.js        # 5 req/s, 1 min   — correctness under light load
│   ├── load.js         # ramp 0->100 req/s over 2 min, hold 10 min
│   ├── stress.js       # step 100->200->400->800 req/s, find the wall
│   └── soak.js         # 50 req/s, 60 min — leaks & drift
├── verify.sql          # post-run database consistency checks
└── data/chunks.json    # generated (git-ignored)
```

## Prerequisites

1. The local stack is up and migrated, and the API is serving:
   ```bash
   docker compose up -d postgres
   cd server && npm install && npm run migrate && npm run start   # serves :8473
   ```
2. The Step-2 NDJSON exists (`generator/data/invoices_90d.ndjson`). If not, generate it —
   see the repo README.

## Running

From the repo root, via the Makefile (recommended — it prepares the data feed on first run):

```bash
make k6-prepare     # NDJSON -> loadtest/data/chunks.json (auto-run by the targets below)
make k6-smoke
make k6-load
make k6-stress
make k6-soak
make k6-verify      # run loadtest/verify.sql against Postgres after a run
```

Or by hand (note: run from inside `loadtest/` so k6 finds the data file):

```bash
cd loadtest
node prepare.js
k6 run profiles/smoke.js
```

### Configuration (env vars)

| Var | Default | Meaning |
| --- | --- | --- |
| `BASE_URL` | `http://localhost:8473` | API base URL k6 posts to. |
| `CHUNKS` | `../data/chunks.json` | Data file path (resolved relative to `lib/payloads.js`). |
| `BATCH_SIZE` | `50` | Invoices per batch request. |
| `MALFORMED_RATE` | `0.02` | Fraction of payloads deliberately corrupted. |
| `MAX_INVOICES` | `100000` | Cap on invoices loaded into `chunks.json` (set for `prepare.js`). |

### Streaming metrics to Prometheus (Step 5)

The profiles run standalone today. To stream metrics into the Prometheus instance Step 5 adds,
turn on k6's built-in remote-write output with `K6_PROM=1`:

```bash
# Make: appends -o experimental-prometheus-rw when K6_PROM is set.
K6_PROM=1 K6_PROMETHEUS_RW_SERVER_URL=http://localhost:9090/api/v1/write make k6-load

# By hand, the equivalent flag is:
K6_PROMETHEUS_RW_SERVER_URL=http://localhost:9090/api/v1/write \
  k6 run -o experimental-prometheus-rw profiles/load.js
```

## How the traffic is built (design notes)

- **Batches of 50.** Each VU iteration posts ~50 invoices in one request, mirroring a real
  collector. Batching amortizes HTTP, transaction (`BEGIN`/`COMMIT`), and connection-checkout
  overhead across many rows, so the database — not per-request plumbing — is what the test
  pressures.
- **Open model.** Every profile uses an arrival-rate executor (`constant-`/`ramping-arrival-rate`).
  k6 starts iterations on a fixed schedule regardless of how fast the server responds, so a
  slowing API surfaces as **broken thresholds**, not as a silently throttled offered load (which
  is what a closed VU model would do).
- **2% malformed, by design.** Each invoice has a 2% chance of being corrupted (a dropped
  required field, a broken `invoice_number` format, or a tampered `total_amount`). Malformed
  payloads are posted individually to `POST /api/invoices` and tagged `expected:reject`; the
  test asserts the API answers **400/422 and never 5xx**. Because they are tagged, their
  expected 4xx does not count against the `http_req_failed{expected:ok}` budget. Healthy
  invoices go to `POST /api/invoices/batch`, tagged `expected:ok`.
- **Duplicates are normal, not noise.** Invoices are drawn randomly from the shared pool and
  may repeat. The natural key is `(invoice_number, invoice_date)` and the API is idempotent, so
  a repeat is simply a duplicate — mutating numbers to force uniqueness would make them
  format-invalid. We let duplicates happen and track the ratio via `invos_duplicates`. (If you
  replay against a DB already loaded with this dataset, expect `invos_created ≈ 0` and almost
  everything to be a duplicate — that still exercises the full request path and the thresholds.)
- **SharedArray.** `chunks.json` is parsed once in the init context and shared read-only across
  all VUs, so hundreds of VUs don't each hold a copy of the ~100k-invoice array.

## Reading the results

Thresholds (pass/fail) are in `lib/checks.js`:

- `http_req_duration{expected:ok}`: p95 < 250 ms, p99 < 500 ms.
- `http_req_failed{expected:ok}`: rate < 0.1 % (5xx or network only; 4xx on malformed is excluded by tag).
- `checks`: > 99 % (every batch 200/no-5xx and every malformed 4xx/no-5xx check).

Custom counters parsed from API responses:

- `invos_created`, `invos_duplicates` — from each batch response body.
- `invos_rejected` — count of malformed payloads the API refused (one per malformed single).
- `invos_malformed_sent` — malformed payloads injected. **Sanity check:** `invos_rejected`
  should equal `invos_malformed_sent` (every malformed payload must be rejected, none leaks in).

After a run, confirm the database is consistent:

```bash
make k6-verify
```

`verify.sql` asserts: no duplicate natural keys (no double counting), no orphan items, every
invoice has items, every stored total equals its line-item sum, and prints the per-day
distribution (the Step-2 90-day window, unchanged).

## Stress: the failure point

<!-- STRESS_FINDINGS -->
_Run `make k6-stress` to locate the wall; findings are recorded here._

## Out of scope

No Grafana dashboards yet (Step 5). No Kubernetes — this project stays on Docker Compose.
