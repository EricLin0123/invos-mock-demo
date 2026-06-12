// smoke.js — correctness under light load: 5 requests/s for 1 minute.
// Purpose is to prove the whole path works (data feed, batch posts, malformed rejection,
// counters, thresholds) before pointing real load at it. If smoke fails, nothing else
// is worth running.
import { runIteration } from '../lib/payloads.js';
import { thresholds } from '../lib/checks.js';

export const options = {
  scenarios: {
    smoke: {
      // Arrival-rate (open model): k6 starts iterations on a fixed schedule regardless of
      // how fast prior responses come back, so a slow server can't silently reduce the
      // offered load — exactly what you want when measuring an API under test.
      executor: 'constant-arrival-rate',
      rate: 5,
      timeUnit: '1s',
      duration: '1m',
      preAllocatedVUs: 20,
      maxVUs: 50,
    },
  },
  thresholds: thresholds({ p95: 250, p99: 500, failRate: 0.001 }),
};

export default function () {
  runIteration();
}
