// db.js — single shared pg connection Pool, configured from environment variables.
// Prefer DATABASE_URL; otherwise fall back to individual PG* vars with localhost defaults.

import pg from 'pg';

const { Pool } = pg;

// Build a pool config from env. DATABASE_URL takes precedence when set.
function poolConfig() {
  if (process.env.DATABASE_URL) {
    return { connectionString: process.env.DATABASE_URL };
  }
  return {
    host: process.env.PGHOST || 'localhost',
    port: Number(process.env.PGPORT) || 5432,
    user: process.env.PGUSER || 'invos',
    password: process.env.PGPASSWORD || 'devonly',
    database: process.env.PGDATABASE || 'invoices',
  };
}

// Exported pool is reused across the app (one pool per process).
export const pool = new Pool(poolConfig());

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
