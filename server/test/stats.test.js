// stats.test.js — read-back aggregate endpoints over a small, self-contained fixture.
// Seeds a handful of far-future invoices (the 2098 band) so the aggregates are
// deterministic regardless of any replayed Step-2 data, then cleans them up. The band is
// distinct from invoices.test.js (2099) so the two files can run as concurrent
// `node --test` processes without their cleanups racing on a shared date range.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/app.js';
import { pool } from '../src/db.js';

const app = buildApp({ logger: false });

// Two days of fixtures:
//   2098-03-01: two invoices (toothpaste + beverages)
//   2098-03-02: one invoice  (toothpaste)
const fixtures = [
  {
    invoice_number: 'TT00000101',
    invoice_date: '2098-03-01',
    random_code: '1111',
    seller_tax_id: '11111111',
    seller_name: 'TEST_FIXTURE_SELLER',
    carrier_id: null,
    items: [
      { description: 'Toothpaste', category: 'toothpaste', brand: 'PearlGuard', quantity: 2, unit_price: 50, amount: 100 },
      { description: 'Cola', category: 'beverages', brand: null, quantity: 1, unit_price: 30, amount: 30 },
    ],
  },
  {
    invoice_number: 'TT00000102',
    invoice_date: '2098-03-01',
    random_code: '2222',
    seller_tax_id: '22222222',
    seller_name: 'TEST_FIXTURE_SELLER',
    carrier_id: null,
    items: [
      { description: 'Toothpaste', category: 'toothpaste', brand: 'MintFresh', quantity: 1, unit_price: 70, amount: 70 },
    ],
  },
  {
    invoice_number: 'TT00000103',
    invoice_date: '2098-03-02',
    random_code: '3333',
    seller_tax_id: '33333333',
    seller_name: 'TEST_FIXTURE_SELLER',
    carrier_id: null,
    items: [
      { description: 'Toothpaste', category: 'toothpaste', brand: 'PearlGuard', quantity: 3, unit_price: 40, amount: 120 },
    ],
  },
].map((inv) => ({ ...inv, total_amount: inv.items.reduce((s, it) => s + it.amount, 0) }));

async function cleanup() {
  await pool.query(
    "DELETE FROM invoices WHERE invoice_date >= '2098-01-01' AND invoice_date < '2099-01-01'",
  );
}

before(async () => {
  await cleanup();
  for (const inv of fixtures) {
    const res = await app.inject({ method: 'POST', url: '/api/invoices', payload: inv });
    assert.equal(res.statusCode, 201);
  }
});

after(async () => {
  await cleanup();
  await app.close();
  await pool.end();
});

test('GET /api/stats/daily aggregates count + revenue per day', async () => {
  const res = await app.inject({
    method: 'GET',
    url: '/api/stats/daily?from=2098-03-01&to=2098-03-02',
  });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), [
    { day: '2098-03-01', invoice_count: 2, total_amount: 200 }, // 130 + 70
    { day: '2098-03-02', invoice_count: 1, total_amount: 120 },
  ]);
});

test('GET /api/stats/category-daily filters by category and sums quantity + amount', async () => {
  const res = await app.inject({
    method: 'GET',
    url: '/api/stats/category-daily?category=toothpaste&from=2098-03-01&to=2098-03-02',
  });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), [
    { day: '2098-03-01', category: 'toothpaste', quantity: 3, amount: 170 }, // 2*50 + 1*70
    { day: '2098-03-02', category: 'toothpaste', quantity: 3, amount: 120 },
  ]);
});
