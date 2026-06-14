# invos-mock-demo — Step 3: Ingestion API (Wiring Data into PostgreSQL)

## Context

Step 1 gave us Fastify + Postgres + schema; Step 2 gave us NDJSON mock invoices. Now build the ingestion path: an HTTP endpoint that validates incoming invoices and persists them transactionally. In Step 4, k6 will fire Step-2 data at this endpoint at high rate — design accordingly (validation strictness, idempotency, batch-friendly inserts), but do NOT add queues or workers; keep the architecture a single Fastify service.

## Goal of this step

`POST /api/invoices` accepts a Step-2 invoice JSON, validates it, inserts invoice + items atomically, handles duplicates idempotently, and exposes Prometheus metrics. A small replay script proves the full path with real generated data.

## Tasks

1. **Endpoint** `POST /api/invoices` (`server/src/routes/invoices.js`):
   - Validate with Fastify's built-in JSON Schema (define in `server/src/schemas/invoice.schema.js`): required fields, `invoice_number` pattern `^[A-Z]{2}[0-9]{8}$`, `random_code` pattern `^[0-9]{4}$`, ISO date, items array 1–50 long, integer amounts ≥ 0. Reject unknown extra fields (`additionalProperties: false`).
   - 400 with a structured error body on validation failure.
   - Insert in a single transaction: `INSERT INTO invoices ... ON CONFLICT (invoice_number, invoice_date) DO NOTHING`. If the invoice already existed → respond `200 {status:"duplicate"}` and skip items; on fresh insert → `201 {status:"created", id}`. (Idempotency matters: k6 retries and generator duplicates must not corrupt data or crash.)
   - Server-side consistency check: reject (422) if `total_amount ≠ Σ item.amount` — be a strict gatekeeper, comment why.
2. **Batch endpoint** `POST /api/invoices/batch` accepting up to 500 invoices, same validation per item, one transaction, response reporting `{created, duplicates, rejected:[{index, reason}]}`. Partial success allowed for validation rejects; DB errors roll back the whole batch.
3. **Metrics** (`prom-client`, endpoint `GET /metrics`):
   - `invos_ingest_requests_total{route,status}` counter,
   - `invos_ingest_invoices_total{result="created|duplicate|rejected"}` counter,
   - `invos_ingest_duration_seconds` histogram (route-labeled),
   - default Node process metrics enabled.
4. **Read-back endpoints** (Grafana + sanity): `GET /api/stats/daily?from&to` → rows of `{day, invoice_count, total_amount}`; `GET /api/stats/category-daily?category=` → `{day, category, quantity, amount}`. Plain SQL aggregates, indexed adequately (add a migration `002_stats_indexes.sql` if needed).
5. **Replay script** (`scripts/replay.js`, Node, no new deps): reads an NDJSON file, posts in batches of 200 with limited concurrency (e.g., 4 in flight), prints a summary `{sent, created, duplicates, rejected, elapsed}`. npm script: `npm run replay -- ../generator/data/invoices_90d.ndjson`.
6. **Tests**: schema rejection cases (bad number format, sum mismatch, extra fields); idempotent re-post; batch partial-success accounting; stats endpoints return correct aggregates on a small fixture.
7. **README update**: end-to-end quickstart now runs generate → migrate → serve → replay → query stats.

## Acceptance criteria

- Replaying the full Step-2 file twice ends with: second run reports 100% duplicates, row counts unchanged — proven by `SELECT count(*)`.
- `invoices` count + `invoice_items` count match the generator's emitted totals (print both in the replay summary).
- `/metrics` shows the three custom metrics moving during a replay.
- p95 single-invoice insert latency under ~20 ms locally at modest concurrency (not a hard gate; note the measured value in README).
- All tests pass.

## Out of scope

No k6 (Step 4), no Grafana provisioning (Step 5), no message queues, no auth.

If you added any subfolder one level down the project root, please add a readme.md in it describing what the codes here are abouit and how to use them. If there are any data that's generated or cached, please add corresponding gitignore rules to avoid them being committed to the repository.
