// migrate.js — tiny migration runner with no external framework.
// Applies db/migrations/*.sql in filename order, recording applied files in a
// schema_migrations table so re-runs are idempotent. Each file runs in a transaction.

import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool } from '../src/db.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
// Migrations live at <repo>/db/migrations (server/scripts -> ../../db/migrations).
const migrationsDir = join(__dirname, '..', '..', 'db', 'migrations');

async function run() {
  // Track which migrations have already been applied.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename   TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  const files = (await readdir(migrationsDir))
    .filter((f) => f.endsWith('.sql'))
    .sort(); // filename order == apply order

  const { rows } = await pool.query('SELECT filename FROM schema_migrations');
  const applied = new Set(rows.map((r) => r.filename));

  let count = 0;
  for (const file of files) {
    if (applied.has(file)) {
      console.log(`skip   ${file} (already applied)`);
      continue;
    }
    const sql = await readFile(join(migrationsDir, file), 'utf8');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [file]);
      await client.query('COMMIT');
      console.log(`apply  ${file}`);
      count += 1;
    } catch (err) {
      await client.query('ROLLBACK');
      console.error(`failed ${file}: ${err.message}`);
      throw err;
    } finally {
      client.release();
    }
  }

  console.log(`done: ${count} migration(s) applied`);
  await pool.end();
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
