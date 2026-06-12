// soak.js — moderate, steady load for a long time: 50 requests/s for 60 minutes.
// A soak surfaces problems a short run hides: memory leaks, connection-pool exhaustion,
// disk/WAL growth, and latency drift as tables and indexes grow. The rate is deliberately
// well under the load profile so any degradation is attributable to duration, not pressure.
import { runIteration } from '../lib/payloads.js';
import { thresholds } from '../lib/checks.js';

export const options = {
  scenarios: {
    soak: {
      executor: 'constant-arrival-rate',
      rate: 50,
      timeUnit: '1s',
      duration: '60m',
      preAllocatedVUs: 150,
      maxVUs: 400,
    },
  },
  thresholds: thresholds({ p95: 250, p99: 500, failRate: 0.001 }),
};

export default function () {
  runIteration();
}
