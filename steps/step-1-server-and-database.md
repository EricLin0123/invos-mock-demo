# invos-mock-demo — Step 1: Server Setup & Database Connection

## Context

You are building **invos-mock-demo**, a small demo project that ingests mock Taiwanese e-invoice data into a local database for testing and development. This is Step 1 of 5. Quality bar: simple, readable, well-commented code — this repo is a portfolio exhibit for a backend interview.

**Tech constraints (entire project):** Node.js 20 + Fastify, PostgreSQL 16, Python via uv (later steps), k6 (later steps), Grafana (later steps). Containers run via Docker (OrbStack). Do not introduce any other databases, ORMs heavier than a query builder, or global tool installs. Everything lives in one repo directory.

## Goal of this step

A running Fastify server connected to a Dockerized PostgreSQL, with the invoice schema migrated and a health endpoint proving DB connectivity end to end.

## Tasks

1. **Scaffold the repo:**
    ```
    invos-mock-demo/
    ├── README.md              # one-paragraph project description + quickstart
    ├── docker-compose.yml     # postgres:16 only (more services come in later steps)
    ├── server/                # Node.js + Fastify app
    │   ├── package.json
    │   ├── src/
    │   │   ├── app.js         # Fastify factory (no listen) — keeps it testable
    │   │   ├── server.js      # entrypoint: builds app, listens, graceful shutdown
    │   │   ├── db.js          # pg Pool, config from env vars
    │   │   └── routes/health.js
    │   └── test/
    └── db/
        └── migrations/
            └── 001_init.sql
    ```
2. **docker-compose.yml**: `postgres:16` with env `POSTGRES_USER=invos`, `POSTGRES_PASSWORD=devonly`, `POSTGRES_DB=invoices` (comment: `# demo-only credentials`), port 5432, named volume, and a healthcheck (`pg_isready`).
3. **Schema** (`001_init.sql`) — mock Taiwanese e-invoice shape, with comments on every column:
    - `invoices`: `id BIGSERIAL PK`, `invoice_number CHAR(10)` (2 uppercase letters + 8 digits, e.g. `AB12345678`), `invoice_date DATE`, `random_code CHAR(4)`, `seller_tax_id CHAR(8)`, `seller_name TEXT`, `carrier_id TEXT NULL` (mobile barcode like `/A1B2C3D`), `total_amount INTEGER` (NTD, no cents), `created_at TIMESTAMPTZ DEFAULT now()`.
    - `invoice_items`: `id BIGSERIAL PK`, `invoice_id BIGINT REFERENCES invoices ON DELETE CASCADE`, `description TEXT`, `category TEXT`, `brand TEXT`, `quantity INTEGER`, `unit_price INTEGER`, `amount INTEGER`.
    - **Unique constraint on `(invoice_number, invoice_date)`** — real Taiwanese invoice numbers are only unique per bimonthly period, so number alone is NOT a valid key. Add a comment explaining this.
    - Indexes: `invoices(invoice_date)`, `invoice_items(category)`, `invoice_items(invoice_id)`.
4. **Migration runner**: a tiny `server/scripts/migrate.js` that applies `db/migrations/*.sql` in filename order, tracking applied files in a `schema_migrations` table. No external migration framework.
5. **Fastify app**: use the `pg` package (Pool). `GET /healthz` returns `{ status: "ok", db: true }` after a successful `SELECT 1`; returns 503 with `db: false` if the pool fails. Load config from env (`DATABASE_URL` or PG\* vars) with sane localhost defaults.
6. **npm scripts**: `dev` (node --watch), `start`, `migrate`, `test`.
7. **Tests** (node:test or vitest, pick one and stay with it): app factory builds; `/healthz` returns ok against the compose Postgres.
8. **README quickstart** (must actually work):
    ```bash
    docker compose up -d postgres
    cd server && npm install && npm run migrate && npm run dev
    curl localhost:8473/healthz
    ```

## Acceptance criteria

- `docker compose up -d postgres` → healthy container.
- `npm run migrate` is idempotent (running twice changes nothing).
- `curl localhost:8473/healthz` → `200 {"status":"ok","db":true}`.
- Stopping Postgres makes `/healthz` return 503 (server must not crash).
- All tests pass; every file has a short top-of-file comment stating its role.

## Out of scope for this step

No ingestion endpoints, no data generation, no k6, no Grafana. Do not pre-build them.
