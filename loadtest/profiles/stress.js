// stress.js — find the wall. Step the offered rate 100 -> 200 -> 400 -> 800 req/s, holding
// each step ~2 min, and let k6 abort the moment a threshold breaks. The point is not to
// pass: it is to discover which threshold breaks first and at what RPS (see README).
import { runIteration } from '../lib/payloads.js';
import { thresholds } from '../lib/checks.js';

export const options = {
  scenarios: {
    stress: {
      executor: 'ramping-arrival-rate',
      startRate: 0,
      timeUnit: '1s',
      // Generously over-provisioned: at 800 req/s with slowing responses, k6 may need many
      // hundreds of concurrent VUs to keep offering load. maxVUs caps that so k6 itself
      // doesn't become the bottleneck; if it hits the cap that is itself a finding.
      preAllocatedVUs: 400,
      maxVUs: 2500,
      // Short ramp into each plateau, then hold — produces visible "steps" rather than one
      // long linear climb, so the failure point maps cleanly to a single RPS plateau.
      stages: [
        { target: 100, duration: '20s' },
        { target: 100, duration: '1m40s' },
        { target: 200, duration: '20s' },
        { target: 200, duration: '1m40s' },
        { target: 400, duration: '20s' },
        { target: 400, duration: '1m40s' },
        { target: 800, duration: '20s' },
        { target: 800, duration: '1m40s' },
      ],
    },
  },
  // abortOnFail: stop at the first broken threshold so the run ends at the wall.
  thresholds: thresholds({ p95: 250, p99: 500, failRate: 0.001, abortOnFail: true }),
};

export default function () {
  runIteration();
}
