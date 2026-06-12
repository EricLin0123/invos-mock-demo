// server.js — entrypoint: builds the app, listens, and shuts down gracefully on signals.

import { buildApp } from './app.js';
import { pool } from './db.js';

const app = buildApp();

const port = Number(process.env.PORT) || 3000;
const host = process.env.HOST || '0.0.0.0';

// Close the HTTP server and the DB pool cleanly so we don't leak connections.
async function shutdown(signal) {
  app.log.info(`Received ${signal}, shutting down...`);
  try {
    await app.close();
    await pool.end();
    process.exit(0);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => shutdown(signal));
}

try {
  await app.listen({ port, host });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
