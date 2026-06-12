// routes/health.js — health endpoint proving DB connectivity end to end.
// GET /healthz: 200 {status:"ok", db:true} when the DB responds; 503 {status:"error", db:false} otherwise.

import { pingDb } from '../db.js';

export default async function healthRoutes(fastify) {
  fastify.get('/healthz', async (request, reply) => {
    const db = await pingDb();
    if (db) {
      return { status: 'ok', db: true };
    }
    // DB unreachable: signal unhealthy without crashing the server.
    reply.code(503);
    return { status: 'error', db: false };
  });
}
