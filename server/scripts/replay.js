// replay.js — replay a Step-2 NDJSON file at the ingestion API to prove the full path.
// Reads the file, posts invoices in batches of 200 to POST /api/invoices/batch with a
// bounded number of in-flight requests (default 4), and prints a summary:
//   { sent, created, duplicates, rejected, elapsed_s, db_invoices, db_items }
// No external dependencies — uses Node's built-in fetch and readline.
//
// Usage (from server/):  npm run replay -- ../generator/data/invoices_90d.ndjson
//   env: BASE_URL (default http://localhost:8473), BATCH_SIZE (200), CONCURRENCY (4)

import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { pool } from '../src/db.js';

const file = process.argv[2];
if (!file) {
  console.error('usage: node scripts/replay.js <path-to.ndjson>');
  process.exit(1);
}

const BASE_URL = process.env.BASE_URL || 'http://localhost:8473';
const BATCH_SIZE = Number(process.env.BATCH_SIZE) || 200;
const CONCURRENCY = Number(process.env.CONCURRENCY) || 4;

// Read the NDJSON file lazily into batches so we never hold the whole file in memory.
async function* batches(path, size) {
  const rl = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
  let batch = [];
  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    batch.push(JSON.parse(trimmed));
    if (batch.length === size) {
      yield batch;
      batch = [];
    }
  }
  if (batch.length) yield batch;
}

// POST one batch and fold its result into the running totals.
async function postBatch(batch, totals) {
  const res = await fetch(`${BASE_URL}/api/invoices/batch`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(batch),
  });
  totals.sent += batch.length;
  if (!res.ok) {
    // A whole-batch failure (e.g. DB error/400) — count items as rejected and keep going.
    totals.rejected += batch.length;
    const text = await res.text().catch(() => '');
    console.error(`batch failed: HTTP ${res.status} ${text.slice(0, 200)}`);
    return;
  }
  const body = await res.json();
  totals.created += body.created || 0;
  totals.duplicates += body.duplicates || 0;
  totals.rejected += (body.rejected || []).length;
}

async function main() {
  const totals = { sent: 0, created: 0, duplicates: 0, rejected: 0 };
  const start = Date.now();

  // Bounded concurrency: keep up to CONCURRENCY postBatch promises in flight at once.
  const inFlight = new Set();
  for await (const batch of batches(file, BATCH_SIZE)) {
    const p = postBatch(batch, totals).finally(() => inFlight.delete(p));
    inFlight.add(p);
    if (inFlight.size >= CONCURRENCY) {
      await Promise.race(inFlight);
    }
  }
  await Promise.all(inFlight);

  const elapsed_s = (Date.now() - start) / 1000;

  // Read back the persisted row counts so the summary can be compared to the
  // generator's emitted totals (acceptance criterion).
  const inv = await pool.query('SELECT count(*)::bigint AS n FROM invoices');
  const items = await pool.query('SELECT count(*)::bigint AS n FROM invoice_items');
  await pool.end();

  const summary = {
    sent: totals.sent,
    created: totals.created,
    duplicates: totals.duplicates,
    rejected: totals.rejected,
    elapsed_s: Number(elapsed_s.toFixed(2)),
    db_invoices: Number(inv.rows[0].n),
    db_items: Number(items.rows[0].n),
  };
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
