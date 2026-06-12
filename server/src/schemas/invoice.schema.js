// invoice.schema.js — JSON Schemas for invoice ingestion, used by Fastify's built-in
// validation (Ajv). One strict schema describes a single Step-2 invoice; the single and
// batch endpoints reuse it. additionalProperties:false everywhere so unexpected fields
// from a misbehaving client are rejected rather than silently dropped.

// A single line item. Amounts are integer NTD (no cents); the server cross-checks that
// quantity*unit_price and the invoice total are internally consistent (see routes/invoices.js).
const item = {
  type: 'object',
  additionalProperties: false,
  required: ['description', 'category', 'quantity', 'unit_price', 'amount'],
  properties: {
    description: { type: 'string', minLength: 1 },
    category: { type: 'string', minLength: 1 },
    // brand is nullable: unbranded goods (snacks, water) carry null in the generator output.
    brand: { type: ['string', 'null'] },
    quantity: { type: 'integer', minimum: 0 },
    unit_price: { type: 'integer', minimum: 0 },
    amount: { type: 'integer', minimum: 0 },
  },
};

// A single invoice matching the Step-2 NDJSON shape exactly.
export const invoiceSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'invoice_number',
    'invoice_date',
    'random_code',
    'seller_tax_id',
    'seller_name',
    'total_amount',
    'items',
  ],
  properties: {
    // 2 uppercase letters + 8 digits, e.g. AB12345678.
    invoice_number: { type: 'string', pattern: '^[A-Z]{2}[0-9]{8}$' },
    // ISO calendar date (YYYY-MM-DD).
    invoice_date: { type: 'string', format: 'date' },
    // 4-digit verification code.
    random_code: { type: 'string', pattern: '^[0-9]{4}$' },
    // Seller's 8-digit unified business number.
    seller_tax_id: { type: 'string', pattern: '^[0-9]{8}$' },
    seller_name: { type: 'string', minLength: 1 },
    // Mobile-barcode carrier; nullable — not every invoice uses one.
    carrier_id: { type: ['string', 'null'] },
    total_amount: { type: 'integer', minimum: 0 },
    items: { type: 'array', minItems: 1, maxItems: 50, items: item },
  },
};

// Body schema for POST /api/invoices — the invoice object itself.
export const singleBody = invoiceSchema;

// Body schema for POST /api/invoices/batch — an array of 1..500 objects.
// Intentionally loose: it only enforces the array shape and size so that a single bad
// invoice does NOT 400 the whole request. Per-item schema + consistency validation runs
// in the handler (via ingest.validateInvoice), which reports rejects as partial success.
export const batchBody = {
  type: 'array',
  minItems: 1,
  maxItems: 500,
  items: { type: 'object' },
};
