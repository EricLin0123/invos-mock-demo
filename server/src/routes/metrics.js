// routes/metrics.js — Prometheus scrape endpoint.
// GET /metrics serializes the shared registry (custom ingestion metrics + default Node
// process metrics) in the text exposition format Prometheus expects.

import { registry } from '../metrics.js';

export default async function metricsRoutes(fastify) {
  fastify.get('/metrics', async (request, reply) => {
    reply.header('Content-Type', registry.contentType);
    return registry.metrics();
  });
}
