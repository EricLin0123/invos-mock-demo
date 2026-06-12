// load.js — sustained target load: ramp 0 -> 100 requests/s over 2 min, hold for 10 min.
// Each request carries ~50 invoices, so a held 100 req/s offers ~5,000 invoices/s to the
// API. This is the profile whose thresholds define "healthy" for the demo.
import { runIteration } from '../lib/payloads.js';
import { thresholds } from '../lib/checks.js';

export const options = {
  scenarios: {
    load: {
      // Open model: offered RPS follows the schedule below, decoupled from response time,
      // so backpressure shows up as failed thresholds rather than as a quietly throttled rate.
      executor: 'ramping-arrival-rate',
      startRate: 0,
      timeUnit: '1s',
      // Pre-allocate enough VUs to keep ~100 req/s in flight even if each iteration (a
      // 50-row batch insert plus the occasional malformed single) takes a few hundred ms.
      preAllocatedVUs: 200,
      maxVUs: 600,
      stages: [
        { target: 100, duration: '2m' }, // ramp up
        { target: 100, duration: '10m' }, // hold
      ],
    },
  },
  thresholds: thresholds({ p95: 250, p99: 500, failRate: 0.001 }),
};

export default function () {
  runIteration();
}
