// db.js — single shared pg connection Pool, configured from environment variables.
// Prefer DATABASE_URL; otherwise fall back to individual PG* vars with localhost defaults.

import pg from 'pg';

const { Pool } = pg;

// Per-pool connection cap. Under K8s autoscaling every pod opens its own pool, so the
// fleet's total backend connections = replicas × max. Keep this small (e.g. 5) and let
// PgBouncer fan the pods into a bounded server-side connection set — otherwise N pods ×
// default max:10 quickly exhausts Postgres' max_connections. See k8s/README.md (§pooling).
const POOL_MAX = Number(process.env.PG_POOL_MAX) || 10;

// Build a pool config from env. DATABASE_URL takes precedence when set.
function poolConfig() {
  if (process.env.DATABASE_URL) {
    return { connectionString: process.env.DATABASE_URL, max: POOL_MAX };
  }
  return {
    host: process.env.PGHOST || 'localhost',
    port: Number(process.env.PGPORT) || 5432,
    user: process.env.PGUSER || 'invos',
    password: process.env.PGPASSWORD || 'devonly',
    database: process.env.PGDATABASE || 'invoices',
    max: POOL_MAX,
  };
}

// Exported pool is reused across the app (one pool per process).
export const pool = new Pool(poolConfig());

// node-postgres emits 'error' on idle clients when the backend dies (e.g. Postgres
// stops). Without a listener Node treats it as an unhandled 'error' and crashes the
// process. Log and swallow it so /healthz can keep reporting 503 instead.
pool.on('error', (err) => {
  console.error('pg pool error (idle client):', err.message);
});

// Lightweight connectivity check used by the health endpoint.
// Returns true on a successful round-trip, false if the pool/query fails.
export async function pingDb() {
  try {
    await pool.query('SELECT 1');
    return true;
  } catch {
    return false;
  }
}
