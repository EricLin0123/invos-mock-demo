// app.js — Fastify application factory. Builds and returns the app WITHOUT listening,
// so tests can inject requests via app.inject() without binding a port.

import Fastify from 'fastify';
import healthRoutes from './routes/health.js';
import invoiceRoutes from './routes/invoices.js';
import statsRoutes from './routes/stats.js';
import metricsRoutes from './routes/metrics.js';

export function buildApp(opts = {}) {
  const app = Fastify({
    logger: opts.logger ?? true,
    // Fastify's Ajv defaults to removeAdditional:true, which silently strips unknown
    // fields. We want to REJECT them (additionalProperties:false on our schemas), so
    // turn that off and act as a strict gatekeeper on incoming invoices.
    ajv: { customOptions: { removeAdditional: false } },
  });

  // Register route plugins.
  app.register(healthRoutes);
  app.register(invoiceRoutes); // POST /api/invoices, POST /api/invoices/batch
  app.register(statsRoutes); //   GET /api/stats/daily, GET /api/stats/category-daily
  app.register(metricsRoutes); // GET /metrics (Prometheus)

  return app;
}
