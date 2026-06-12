// metrics.js — Prometheus metrics for the ingestion service.
// Defines a single shared registry, the three custom ingestion metrics required by
// Step 3, and enables default Node.js process metrics. Routes import these to record
// activity; GET /metrics (routes/metrics.js) serializes the registry for Prometheus.

import client from 'prom-client';

// One registry for the whole process.
export const registry = new client.Registry();

// Default Node process metrics (event loop lag, heap, CPU, GC, etc.).
client.collectDefaultMetrics({ register: registry });

// Total ingestion HTTP requests, labelled by route and HTTP status code.
export const requestsTotal = new client.Counter({
  name: 'invos_ingest_requests_total',
  help: 'Total ingestion HTTP requests, by route and status code.',
  labelNames: ['route', 'status'],
  registers: [registry],
});

// Total invoices processed, labelled by per-invoice outcome.
export const invoicesTotal = new client.Counter({
  name: 'invos_ingest_invoices_total',
  help: 'Total invoices processed, by result.',
  labelNames: ['result'], // created | duplicate | rejected
  registers: [registry],
});

// Request duration histogram, labelled by route. Buckets chosen around the
// ~20 ms single-insert target so the p95 acceptance check is observable.
export const ingestDuration = new client.Histogram({
  name: 'invos_ingest_duration_seconds',
  help: 'Ingestion request duration in seconds, by route.',
  labelNames: ['route'],
  buckets: [0.001, 0.005, 0.01, 0.02, 0.05, 0.1, 0.25, 0.5, 1, 2.5],
  registers: [registry],
});
