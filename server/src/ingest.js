// ingest.js — core ingestion logic shared by the single and batch endpoints.
// Keeps validation + persistence in one place so both routes behave identically:
//   - validateInvoice: structural JSON-Schema check (standalone Ajv, used by the batch
//     endpoint for per-item partial-success; the single endpoint uses Fastify's own Ajv).
//   - consistencyError: server-side total vs. line-item sum gatekeeping.
//   - insertInvoice: idempotent transactional insert of an invoice and its items.

import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { invoiceSchema } from './schemas/invoice.schema.js';

// Standalone validator for the batch path. We deliberately do NOT reuse Fastify's
// request validator here because batch wants per-item partial success rather than a
// single 400 for the whole body. Mirrors Fastify's setup (ajv-formats for `date`).
const ajv = new Ajv({ allErrors: true, removeAdditional: false });
addFormats(ajv);
const validate = ajv.compile(invoiceSchema);

// Validate one invoice object against the schema.
// Returns { valid: true } or { valid: false, reason } with a compact human message.
export function validateInvoice(invoice) {
  const valid = validate(invoice);
  if (valid) return { valid: true };
  const reason = (validate.errors || [])
    .map((e) => `${e.instancePath || '/'} ${e.message}`)
    .join('; ');
  return { valid: false, reason: reason || 'schema validation failed' };
}

// Server-side consistency gate. Taiwanese e-invoices print a single total that must
// equal the sum of their line items; a mismatch means corrupt/forged data, so we refuse
// it rather than persisting a total that disagrees with its own items (returned as 422).
// Returns an error string when inconsistent, or null when the invoice is sound.
export function consistencyError(invoice) {
  const sum = invoice.items.reduce((acc, it) => acc + it.amount, 0);
  if (sum !== invoice.total_amount) {
    return `total_amount ${invoice.total_amount} != sum(items.amount) ${sum}`;
  }
  return null;
}

// Insert one invoice and its items using the provided (already-in-transaction) client.
// Idempotent: ON CONFLICT on the (invoice_number, invoice_date) natural key DO NOTHING,
// so a replayed/duplicate invoice is a no-op. Returns { status, id }:
//   - { status: 'created', id }   on a fresh insert (items inserted)
//   - { status: 'duplicate' }     when the invoice already existed (items skipped)
export async function insertInvoice(client, invoice) {
  const ins = await client.query(
    `INSERT INTO invoices
       (invoice_number, invoice_date, random_code, seller_tax_id, seller_name, carrier_id, total_amount)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (invoice_number, invoice_date) DO NOTHING
     RETURNING id`,
    [
      invoice.invoice_number,
      invoice.invoice_date,
      invoice.random_code,
      invoice.seller_tax_id,
      invoice.seller_name,
      invoice.carrier_id ?? null,
      invoice.total_amount,
    ],
  );

  // No row returned => the natural key already existed => duplicate, skip items.
  if (ins.rowCount === 0) {
    return { status: 'duplicate' };
  }

  const invoiceId = ins.rows[0].id;

  // Bulk-insert items in a single statement (batch-friendly for Step 4's load test).
  const values = [];
  const params = [];
  invoice.items.forEach((it, i) => {
    const b = i * 7;
    values.push(`($${b + 1}, $${b + 2}, $${b + 3}, $${b + 4}, $${b + 5}, $${b + 6}, $${b + 7})`);
    params.push(
      invoiceId,
      it.description,
      it.category,
      it.brand ?? null,
      it.quantity,
      it.unit_price,
      it.amount,
    );
  });
  await client.query(
    `INSERT INTO invoice_items
       (invoice_id, description, category, brand, quantity, unit_price, amount)
     VALUES ${values.join(', ')}`,
    params,
  );

  return { status: 'created', id: invoiceId };
}
