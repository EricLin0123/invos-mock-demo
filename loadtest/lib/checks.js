// checks.js — shared k6 custom metrics and the per-profile threshold factory.
//
// Custom counters are parsed out of the API responses (see payloads.js) so the load test
// reports the same created/duplicate/rejected story the API itself records, independent of
// k6's built-in HTTP metrics:
//   invos_created     — invoices the API reported as freshly inserted
//   invos_duplicates  — invoices the API reported as already present (idempotent no-ops)
//   invos_rejected    — payloads the API refused (4xx); should track malformed-sent closely
//   invos_malformed_sent — malformed payloads we deliberately injected (the sanity baseline)
import { Counter } from 'k6/metrics';

export const invosCreated = new Counter('invos_created');
export const invosDuplicates = new Counter('invos_duplicates');
export const invosRejected = new Counter('invos_rejected');
export const invosMalformedSent = new Counter('invos_malformed_sent');

// Build the thresholds block for a profile.
//   p95/p99   — latency budget for the healthy traffic (tagged expected:ok), in ms.
//   failRate  — max share of expected:ok requests allowed to fail (5xx or network). 4xx on
//               malformed payloads is expected and lives under expected:reject, so it is
//               excluded here by tag — malformed traffic must not fail the run.
//   abortOnFail — stress uses this so k6 stops at the first broken threshold, which is
//               exactly the "wall" we are trying to locate.
export function thresholds({ p95 = 250, p99 = 500, failRate = 0.001, abortOnFail = false } = {}) {
  const dur = [`p(95)<${p95}`, `p(99)<${p99}`];
  const fail = [`rate<${failRate}`];
  const wrap = (arr) =>
    abortOnFail ? arr.map((t) => ({ threshold: t, abortOnFail: true })) : arr;

  return {
    // Latency + failure budgets apply only to the healthy traffic.
    'http_req_duration{expected:ok}': wrap(dur),
    'http_req_failed{expected:ok}': wrap(fail),
    // Malformed payloads must be answered with a 4xx and never a 5xx; the per-request
    // checks assert this, so a healthy run keeps check success effectively at 100%.
    checks: ['rate>0.99'],
  };
}
