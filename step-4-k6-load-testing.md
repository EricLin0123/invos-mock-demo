# invos-mock-demo — Step 4: Load Testing with Grafana k6

## Context

The ingestion API (Step 3) works and is idempotent. Now make k6 the traffic engine: it replays Step-2 NDJSON data against the API under controlled load shapes, with thresholds that turn performance expectations into pass/fail tests. k6 is installed as a local binary (`brew install k6`) — no extensions, no k6 cloud.

## Goal of this step

Four runnable k6 profiles (smoke / load / stress / soak) that replay generated invoice data, inject a controlled fraction of malformed payloads, enforce latency/error thresholds, and report a clean summary. Results become the load story Grafana visualizes in Step 5.

## Tasks

1. **Scaffold:**
   ```
   loadtest/
   ├── README.md              # how to run each profile, how to read results
   ├── prepare.js             # Node script: NDJSON → data/chunks.json (k6 SharedArray-friendly)
   ├── lib/
   │   ├── payloads.js        # load chunks, pick invoices, mutate-to-malformed helper
   │   └── checks.js          # shared checks/thresholds
   └── profiles/
       ├── smoke.js           # 5 VUs, 1 min — correctness under light load
       ├── load.js            # ramp to target RPS, hold 10 min
       ├── stress.js          # step up until failure, find the wall
       └── soak.js            # moderate RPS, 60 min — leaks & drift
   ```
2. **Data feed**: k6 can't stream huge files line-by-line efficiently; `prepare.js` converts NDJSON into one JSON array file (cap at ~100k invoices, documented), loaded in k6 via `SharedArray` (loaded once, shared across VUs — note the memory rationale in a comment).
3. **Traffic realism** in `payloads.js`:
   - Each VU iteration posts a batch of 50 invoices to `/api/invoices/batch` (mirrors real collector behavior; comment why batch > single for throughput).
   - **2% of payloads deliberately malformed** (drop a required field / break the number format / corrupt the total) — tag these requests `expected:"reject"`; assert the API answers 400/422, never 5xx. Malformed traffic is part of the test, not noise.
   - Unique-enough data per run: prepend a run ID to... NO — invoice numbers must stay format-valid; instead accept duplicates as normal (the API is idempotent) and track the `duplicate` ratio as a metric. Comment this design choice.
4. **Load shapes** (`scenarios` + `ramping-arrival-rate` executor — open model, so response slowdowns don't silently reduce offered load; comment this):
   - smoke: 5 req/s, 1 min.
   - load: ramp 0→100 req/s over 2 min, hold 10 min. (Each request = 50 invoices ⇒ ~5,000 invoices/s offered.)
   - stress: steps 100 → 200 → 400 → 800 req/s, 2 min each, until thresholds break.
   - soak: 50 req/s, 60 min.
5. **Thresholds** (in `checks.js`, applied per profile):
   - `http_req_duration{expected:ok}`: p95 < 250 ms (load), p99 < 500 ms.
   - `http_req_failed{expected:ok}`: rate < 0.1% (5xx or network only — 4xx on malformed payloads is expected and excluded via tags).
   - Custom counters: `invos_created`, `invos_duplicates`, `invos_rejected` parsed from API responses; sanity check `rejected ≈ malformed sent`.
6. **k6 → Prometheus**: run k6 with the built-in Prometheus remote-write output (`-o experimental-prometheus-rw`) targeting the Prometheus instance that Step 5 will add; make the flag optional via an env var so profiles also run standalone now. Document the exact command in README.
7. **Verification queries** (`loadtest/verify.sql`): after a load run, row counts and per-day distribution in Postgres must match expectations (no gaps, no double counting).
8. **Makefile or npm scripts** at repo root: `make k6-smoke`, `make k6-load`, `make k6-stress`, `make k6-soak`.

## Acceptance criteria

- Smoke and load profiles pass all thresholds against the local stack.
- Stress profile produces a documented failure point: which threshold broke first, at what RPS, and the suspected bottleneck (one paragraph in `loadtest/README.md` — check Postgres connections, Node event loop lag, CPU).
- Malformed-payload rejects ≈ 2% of sent, all 4xx, zero 5xx during smoke/load.
- After any run, `verify.sql` confirms DB consistency.

## Out of scope

No Grafana dashboards yet (Step 5). No kind/Kubernetes — this project stays on Docker Compose.
