# invos-mock-demo

A small demo project that ingests mock Taiwanese e-invoice data into a local PostgreSQL
database for testing and development. It is built up in five steps (server & database, data
generation, ingestion, k6 load testing, Grafana monitoring); this repo currently implements
**Step 1** — a Fastify server connected to a Dockerized PostgreSQL 16, with the invoice schema
migrated and a `/healthz` endpoint that proves database connectivity end to end.

## Quickstart

```bash
docker compose up -d postgres
cd server && npm install && npm run migrate && npm run dev
curl localhost:3000/healthz   # -> {"status":"ok","db":true}
```

## Stack

- Node.js 20 + Fastify (`server/`)
- PostgreSQL 16 via Docker Compose / OrbStack (`docker-compose.yml`)
- Plain SQL migrations with a tiny runner (`db/migrations/`, `server/scripts/migrate.js`)

## Configuration

The server reads `DATABASE_URL`, or falls back to `PGHOST` / `PGPORT` / `PGUSER` /
`PGPASSWORD` / `PGDATABASE` with localhost demo defaults that match `docker-compose.yml`.

## Tests

```bash
cd server && npm test   # requires the compose Postgres to be running and migrated
```

> The build steps are described in `steps/`. Feed them one at a time, in order, verifying each
> step's acceptance criteria before starting the next.
