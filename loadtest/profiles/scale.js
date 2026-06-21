// scale.js — drive the HPA up AND back down, so the autoscaling demo shows pods growing
// then shrinking. Unlike stress.js (which aborts at the first broken threshold to find the
// wall), this profile climbs in steps, then descends all the way back to 0 and idles a
// couple of minutes so the scale-down to the floor is visible in the Grafana panel.
//
// Thresholds here are observe-only (NO abortOnFail): the point is autoscaling behaviour over
// a full up-down cycle, not locating the failure point. Run with `make k6-scale` (set
// K6_PROM=1 to overlay offered load against replica count live in Grafana).
import { runIteration } from '../lib/payloads.js';
import { thresholds } from '../lib/checks.js';

export const options = {
  scenarios: {
    scale: {
      executor: 'ramping-arrival-rate',
      startRate: 0,
      timeUnit: '1s',
      // Headroom to keep offering load up to 500 req/s even as responses slow.
      preAllocatedVUs: 300,
      maxVUs: 1500,
      stages: [
        // Climb in steps, holding each plateau ~90s so the HPA reacts and pods appear.
        { target: 50, duration: '30s' },
        { target: 50, duration: '1m' },
        { target: 150, duration: '30s' },
        { target: 150, duration: '1m30s' },
        { target: 300, duration: '30s' },
        { target: 300, duration: '1m30s' },
        { target: 500, duration: '30s' },
        { target: 500, duration: '1m30s' },
        // Descend back down, holding each step ~60s to watch the shrink.
        { target: 300, duration: '1m' },
        { target: 150, duration: '1m' },
        { target: 50, duration: '1m' },
        { target: 0, duration: '30s' },
        // Idle at zero so scale-down to the floor (minReplicas) is visible.
        { target: 0, duration: '2m' },
      ],
    },
  },
  // Observe-only: relaxed budgets, no abortOnFail, so the whole cycle always completes.
  thresholds: thresholds({ p95: 1000, p99: 2000, failRate: 0.05 }),
};

export default function () {
  runIteration();
}
