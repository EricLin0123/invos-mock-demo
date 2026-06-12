// health.test.js — verifies the app factory builds and /healthz reports DB connectivity.
// The DB test runs against the compose Postgres (DATABASE_URL or PG* defaults to localhost).

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/app.js';
import { pool } from '../src/db.js';

// Quiet logger keeps test output clean.
const app = buildApp({ logger: false });

after(async () => {
  await app.close();
  await pool.end();
});

test('app factory builds a Fastify instance', () => {
  assert.equal(typeof app.inject, 'function');
});

test('GET /healthz returns 200 ok with db:true against compose Postgres', async () => {
  const res = await app.inject({ method: 'GET', url: '/healthz' });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { status: 'ok', db: true });
});
