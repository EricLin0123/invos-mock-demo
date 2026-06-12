// routes/invoices.js — ingestion endpoints.
//   POST /api/invoices        single invoice: validate -> consistency-check -> insert.
//   POST /api/invoices/batch  up to 500 invoices: per-item validation with partial success,
//                             all DB writes in one transaction (DB error rolls back the batch).
// Validation is Fastify's built-in JSON Schema (Ajv); idempotency comes from the
// ON CONFLICT DO NOTHING insert in ingest.js. Metrics are recorded for every request.

import { pool } from '../db.js';
import { singleBody, batchBody } from '../schemas/invoice.schema.js';
import { validateInvoice, consistencyError, insertInvoice } from '../ingest.js';
import { requestsTotal, invoicesTotal, ingestDuration } from '../metrics.js';

// Structured 400 body returned when Fastify's schema validation fails.
const validationErrorHandler = (route) => (error, request, reply) => {
  if (error.validation) {
    requestsTotal.inc({ route, status: 400 });
    invoicesTotal.inc({ result: 'rejected' });
    reply.code(400);
    return reply.send({
      status: 'error',
      error: 'validation_failed',
      details: error.validation.map((v) => ({
        path: v.instancePath || '/',
        message: v.message,
      })),
    });
  }
  // Non-validation errors fall through to Fastify's default handler.
  throw error;
};

export default async function invoiceRoutes(fastify) {
  // ---- Single invoice -----------------------------------------------------
  fastify.post(
    '/api/invoices',
    {
      schema: { body: singleBody },
      // Per-route error handler so a bad body becomes our structured 400.
      errorHandler: validationErrorHandler('/api/invoices'),
    },
    async (request, reply) => {
      const route = '/api/invoices';
      const endTimer = ingestDuration.startTimer({ route });
      const invoice = request.body;

      // Strict gatekeeping: the printed total must match the line-item sum.
      const inconsistency = consistencyError(invoice);
      if (inconsistency) {
        endTimer();
        requestsTotal.inc({ route, status: 422 });
        invoicesTotal.inc({ result: 'rejected' });
        reply.code(422);
        return { status: 'error', error: 'inconsistent_total', message: inconsistency };
      }

      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await insertInvoice(client, invoice);
        await client.query('COMMIT');

        if (result.status === 'duplicate') {
          endTimer();
          requestsTotal.inc({ route, status: 200 });
          invoicesTotal.inc({ result: 'duplicate' });
          reply.code(200);
          return { status: 'duplicate' };
        }
        endTimer();
        requestsTotal.inc({ route, status: 201 });
        invoicesTotal.inc({ result: 'created' });
        reply.code(201);
        return { status: 'created', id: result.id };
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        endTimer();
        requestsTotal.inc({ route, status: 500 });
        request.log.error(err);
        reply.code(500);
        return { status: 'error', error: 'insert_failed', message: err.message };
      } finally {
        client.release();
      }
    },
  );

  // ---- Batch --------------------------------------------------------------
  fastify.post(
    '/api/invoices/batch',
    {
      schema: { body: batchBody },
      errorHandler: validationErrorHandler('/api/invoices/batch'),
    },
    async (request, reply) => {
      const route = '/api/invoices/batch';
      const endTimer = ingestDuration.startTimer({ route });
      const invoices = request.body;

      // First pass (no DB): per-item structural + consistency validation. Rejected items
      // are recorded with their index and skipped; valid items proceed to the transaction.
      // This gives partial success for validation problems without touching the DB.
      const accepted = [];
      const rejected = [];
      invoices.forEach((invoice, index) => {
        const v = validateInvoice(invoice);
        if (!v.valid) {
          rejected.push({ index, reason: v.reason });
          return;
        }
        const inconsistency = consistencyError(invoice);
        if (inconsistency) {
          rejected.push({ index, reason: inconsistency });
          return;
        }
        accepted.push(invoice);
      });

      let created = 0;
      let duplicates = 0;

      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        // All accepted invoices share one transaction: a DB error rolls back the whole
        // batch (atomic), while validation rejects above are reported as partial success.
        for (const invoice of accepted) {
          const result = await insertInvoice(client, invoice);
          if (result.status === 'created') created += 1;
          else duplicates += 1;
        }
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        endTimer();
        requestsTotal.inc({ route, status: 500 });
        request.log.error(err);
        reply.code(500);
        return { status: 'error', error: 'batch_insert_failed', message: err.message };
      } finally {
        client.release();
      }

      endTimer();
      requestsTotal.inc({ route, status: 200 });
      invoicesTotal.inc({ result: 'created' }, created);
      invoicesTotal.inc({ result: 'duplicate' }, duplicates);
      invoicesTotal.inc({ result: 'rejected' }, rejected.length);

      reply.code(200);
      return { created, duplicates, rejected };
    },
  );
}
