// app.js — Fastify application factory. Builds and returns the app WITHOUT listening,
// so tests can inject requests via app.inject() without binding a port.

import Fastify from 'fastify';
import healthRoutes from './routes/health.js';

export function buildApp(opts = {}) {
  const app = Fastify({ logger: opts.logger ?? true });

  // Register route plugins. More routes (ingestion) arrive in later steps.
  app.register(healthRoutes);

  return app;
}
