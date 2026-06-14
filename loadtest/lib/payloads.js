// payloads.js — the work one VU iteration performs: draw invoices from the shared pool,
// inject a controlled fraction of malformed payloads, post them, and fold the API's
// answers into the custom counters.
import http from 'k6/http';
import { check } from 'k6';
import { SharedArray } from 'k6/data';
import {
  invosCreated,
  invosDuplicates,
  invosRejected,
  invosMalformedSent,
} from './checks.js';

const BASE_URL = __ENV.BASE_URL || 'http://localhost:8473';
// Path to the prepared JSON array. k6's open() resolves this relative to THIS module's
// file (loadtest/lib/), so the default points up-and-over to loadtest/data/chunks.json.
const CHUNKS = __ENV.CHUNKS || '../data/chunks.json';

// 50 invoices per request: a batch insert amortizes per-request overhead (HTTP, the
// BEGIN/COMMIT round-trip, the connection checkout) across many rows, which is how a real
// collector ships invoices — single-invoice posts would make the network and transaction
// overhead, not the database, the bottleneck and understate real throughput.
export const BATCH_SIZE = Number(__ENV.BATCH_SIZE) || 50;
// 2% of all invoices are deliberately corrupted so rejection handling is exercised under
// load as a first-class part of the test, not an afterthought.
const MALFORMED_RATE = __ENV.MALFORMED_RATE !== undefined ? Number(__ENV.MALFORMED_RATE) : 0.02;

// SharedArray parses chunks.json exactly once in the init context and shares the result
// read-only across every VU in the process. Without it each of the (potentially hundreds
// of) VUs would parse and hold its own copy of a ~100k-invoice array — gigabytes of
// duplicated heap. The shared copy keeps k6's own memory off the critical path.
const invoices = new SharedArray('invoices', () => JSON.parse(open(CHUNKS)));

// Corrupt one invoice in a way the API must reject. We rotate three independent failure
// modes so the test covers schema rejection (400) and the server-side consistency gate
// (422) rather than a single code path. The source object is deep-cloned first — a
// SharedArray element must never be mutated.
function makeMalformed(invoice) {
  const bad = JSON.parse(JSON.stringify(invoice));
  switch (Math.floor(Math.random() * 3)) {
    case 0:
      // Drop a required field -> JSON-Schema validation fails -> 400.
      delete bad.random_code;
      break;
    case 1:
      // Break the invoice-number format (lowercase) -> pattern fails -> 400.
      bad.invoice_number = bad.invoice_number.toLowerCase();
      break;
    default:
      // Corrupt the total so it no longer equals sum(items.amount) -> consistency gate -> 422.
      bad.total_amount = bad.total_amount + 7;
      break;
  }
  return bad;
}

// Pick a random invoice from the shared pool. We intentionally allow the same invoice to
// be drawn repeatedly across iterations and VUs: the natural key is (invoice_number,
// invoice_date) and the API is idempotent, so a redraw is simply a duplicate. Rather than
// fight that (mutating numbers would make them format-invalid), we let duplicates happen
// and measure them via invos_duplicates — a real ingestion pipeline sees replays too.
function pickInvoice() {
  return invoices[Math.floor(Math.random() * invoices.length)];
}

const JSON_HEADERS = { 'Content-Type': 'application/json' };

// One VU iteration: build BATCH_SIZE payloads, route the healthy ones through the batch
// endpoint and each malformed one through the single endpoint (so we can assert it draws a
// clean 4xx), and update the counters from the responses.
export function runIteration() {
  // Stamp the invoice_date on the fly, at emit time, so invoices arrive dated "now"
  // rather than carrying the pool's pre-baked date. The shared pool object is read-only,
  // so healthy invoices are shallow-cloned with today's date (items are reused as-is).
  const today = new Date().toISOString().slice(0, 10);
  const batch = [];
  const malformed = [];
  for (let i = 0; i < BATCH_SIZE; i += 1) {
    const inv = pickInvoice();
    if (Math.random() < MALFORMED_RATE) {
      const bad = makeMalformed(inv);
      bad.invoice_date = today;
      malformed.push(bad);
    } else {
      batch.push({ ...inv, invoice_date: today });
    }
  }

  // Healthy bulk -> POST /api/invoices/batch, tagged expected:ok so the latency/failure
  // thresholds apply to it. The batch body schema is loose, so a 200 with a partial
  // rejected[] is the success shape; a 5xx or non-200 is a real failure.
  if (batch.length > 0) {
    const res = http.post(`${BASE_URL}/api/invoices/batch`, JSON.stringify(batch), {
      headers: JSON_HEADERS,
      tags: { expected: 'ok', endpoint: 'batch' },
    });
    check(
      res,
      {
        'batch: status 200': (r) => r.status === 200,
        'batch: no 5xx': (r) => r.status < 500,
      },
      { expected: 'ok' },
    );
    if (res.status === 200) {
      const body = res.json();
      invosCreated.add(body.created || 0);
      invosDuplicates.add(body.duplicates || 0);
      // Batches carry only healthy invoices, so this is normally 0; counted for completeness.
      invosRejected.add((body.rejected || []).length);
    }
  }

  // Malformed payloads -> POST /api/invoices one at a time, tagged expected:reject so their
  // (expected) 4xx does NOT count against http_req_failed{expected:ok}. We assert the API
  // answers 400/422 and never 5xx: rejection is a normal, hardened path under load.
  for (const bad of malformed) {
    invosMalformedSent.add(1);
    const res = http.post(`${BASE_URL}/api/invoices`, JSON.stringify(bad), {
      headers: JSON_HEADERS,
      tags: { expected: 'reject', endpoint: 'single' },
    });
    check(
      res,
      {
        'malformed: 4xx reject': (r) => r.status === 400 || r.status === 422,
        'malformed: never 5xx': (r) => r.status < 500,
      },
      { expected: 'reject' },
    );
    invosRejected.add(1);
  }
}
