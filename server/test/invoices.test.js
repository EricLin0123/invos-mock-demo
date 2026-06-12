// invoices.test.js — ingestion endpoint tests: schema rejections, the consistency gate,
// idempotent re-posting, and batch partial-success accounting.
// Runs against the compose Postgres. All fixtures use far-future invoice_dates (the 2099
// band) so the suite can clean up after itself without touching any replayed Step-2 data.
// The band is distinct from stats.test.js (2098) so concurrent `node --test` processes
// don't race on a shared date range.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/app.js';
import { pool } from '../src/db.js';

const app = buildApp({ logger: false });

// Build a valid invoice. Overrides let individual tests bend one field at a time.
function makeInvoice(overrides = {}) {
  const items = overrides.items ?? [
    { description: 'Toothpaste', category: 'toothpaste', brand: 'PearlGuard', quantity: 1, unit_price: 60, amount: 60 },
    { description: 'Mineral Water', category: 'beverages', brand: null, quantity: 2, unit_price: 20, amount: 40 },
  ];
  const total = items.reduce((s, it) => s + it.amount, 0);
  return {
    invoice_number: 'TT00000001',
    invoice_date: '2099-01-01',
    random_code: '1234',
    seller_tax_id: '12345678',
    seller_name: 'TEST_FIXTURE_SELLER',
    carrier_id: '/ABC123Z',
    total_amount: total,
    items,
    ...overrides,
  };
}

// Remove any fixture rows so the suite is repeatable.
async function cleanup() {
  await pool.query(
    "DELETE FROM invoices WHERE invoice_date >= '2099-01-01' AND invoice_date < '2100-01-01'",
  );
}

before(cleanup);
after(async () => {
  await cleanup();
  await app.close();
  await pool.end();
});

async function post(url, payload) {
  return app.inject({ method: 'POST', url, payload });
}

test('rejects a bad invoice_number format with 400', async () => {
  const res = await post('/api/invoices', makeInvoice({ invoice_number: 'bad123' }));
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error, 'validation_failed');
});

test('rejects unknown extra fields with 400 (additionalProperties:false)', async () => {
  const res = await post('/api/invoices', makeInvoice({ surprise: 'nope' }));
  assert.equal(res.statusCode, 400);
});

test('rejects a total/sum mismatch with 422', async () => {
  const res = await post('/api/invoices', makeInvoice({ total_amount: 99999 }));
  assert.equal(res.statusCode, 422);
  assert.equal(res.json().error, 'inconsistent_total');
});

test('creates a fresh invoice (201) and re-posts idempotently (200 duplicate)', async () => {
  const invoice = makeInvoice({ invoice_number: 'TT00000002' });

  const first = await post('/api/invoices', invoice);
  assert.equal(first.statusCode, 201);
  assert.equal(first.json().status, 'created');
  assert.ok(first.json().id);

  const second = await post('/api/invoices', invoice);
  assert.equal(second.statusCode, 200);
  assert.equal(second.json().status, 'duplicate');

  // Exactly one invoice + its items persisted despite two posts.
  const { rows } = await pool.query(
    "SELECT count(*)::int AS n FROM invoices WHERE invoice_number = 'TT00000002'",
  );
  assert.equal(rows[0].n, 1);
});

test('batch reports created/duplicates/rejected with partial success', async () => {
  const batch = [
    makeInvoice({ invoice_number: 'TT00000010' }), // created
    makeInvoice({ invoice_number: 'TT00000011' }), // created
    makeInvoice({ invoice_number: 'TT00000002' }), // duplicate (from previous test)
    makeInvoice({ invoice_number: 'badformat' }), // rejected: schema
    makeInvoice({ invoice_number: 'TT00000012', total_amount: 7 }), // rejected: sum mismatch
  ];

  const res = await post('/api/invoices/batch', batch);
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.created, 2);
  assert.equal(body.duplicates, 1);
  assert.equal(body.rejected.length, 2);
  // Rejected entries carry their original index.
  assert.deepEqual(
    body.rejected.map((r) => r.index).sort((a, b) => a - b),
    [3, 4],
  );
});
