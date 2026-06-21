# Plan — Kubernetes adoption + Lottery Checker + Warranty Reminder

This plan covers three intertwined pieces of work:

1. **Refactor the project onto Kubernetes (K8s)** so the ingestion service is horizontally
   scalable and lifecycle-managed by the cluster.
2. **Make the stress test visibly drive autoscaling** — pods grow as offered traffic ramps
   up and shrink when it ramps back down, both visible in a Grafana panel.
3. **Ship two user-facing features** — the **Lottery Checker** (uniform-invoice 對獎) and the
   **Warranty / Return Reminder** — chosen earlier because each exercises a different K8s
   primitive (a scalable read Deployment + HPA, and a scheduled CronJob).

The guiding constraint throughout: this is a **fully self-contained project** (generator →
ingest API → Postgres → monitoring). Every new feature that changes the *data modality* must
be traced end-to-end — generator output, Ajv validation, DB schema, ingest insert, and the
demo seed — so the feature is actually visible in a fresh `up`.

---

## 0. Success criteria (definition of done)

- `bash scripts/run.sh up` brings up a local K8s cluster with Postgres, the ingest
  Deployment, Prometheus, Grafana, and the two CronJobs — no host-run Node process.
- Running the stress profile causes the ingest Deployment to scale **out** (e.g. 1 → 6 pods)
  as offered rate climbs, then scale **back in** to the floor after traffic stops.
- A Grafana panel overlays **replica count vs k6 offered load vs p99 latency** on one time
  axis, so the grow/shrink is obvious at a glance.
- `GET /api/lottery/check?carrier=…&period=…` returns the carrier's winning invoices and prize
  amounts; a CronJob refreshes the bimonthly draw + precomputed winners.
- A daily CronJob populates warranty/return reminders; `GET /api/reminders?carrier=…` returns
  them, and a Grafana panel shows reminders coming due.
- `npm test` and `uv run pytest` stay green; new code has tests.

---

## 1. Why the architecture has to change

Today the **server runs on the host** (`scripts/run.sh` step 4 starts `npm run start` on
`:8473`); Postgres, Prometheus, Grafana run in Docker Compose, and Prometheus scrapes the host
via `host.docker.internal`. A host process **cannot be horizontally scaled or autoscaled** —
there is exactly one of it. To demonstrate HPA we must:

- **Containerize the server** and run it as a K8s **Deployment** (N replicas behind a Service).
- **Move Prometheus into the cluster**, because autoscaled pods get ephemeral, non-routable
  pod IPs — Prometheus needs Kubernetes **service discovery** to scrape a changing set of pods.
  Scraping a fixed `host.docker.internal:8473` no longer makes sense once there are many pods.
- **Add kube-state-metrics**, so the replica count and HPA status become Prometheus
  timeseries we can graph (that is the data behind the "grow/shrink" panel).
- Keep **k6 on the host** (unchanged philosophy), pointing at a stable NodePort instead of
  `localhost:8473`.

### Target topology (all inside one local cluster)

```
                       ┌─────────────────────── kind cluster ───────────────────────┐
 host k6  ──NodePort──▶│  Service(invos-ingest)  ──▶  Deployment(invos-ingest) ⟲HPA  │
 (stress.js)           │        :8473                   [1..N pods, /metrics]         │
                       │                                      │                       │
 browser ──NodePort──▶ │  Grafana ◀── Prometheus ──scrape──── ┘                       │
 :8474                 │              │  ▲    ▲                                        │
                       │              │  │    └── kube-state-metrics (replica counts)  │
 host k6 ─remote-write─┼──NodePort──▶ │  └────── metrics-server (HPA resource metrics) │
 (k6 metrics)          │              ▼                                                │
                       │  StatefulSet(postgres) + PVC   ◀── CronJob(lottery-draw)      │
                       │                                ◀── CronJob(warranty-scan)     │
                       └─────────────────────────────────────────────────────────────┘
```

### Local cluster choice

Use **kind** (Kubernetes-in-Docker): it reuses the Docker that Compose already requires, lets
us `kind load docker-image` our locally built server image (no registry needed), and supports
`extraPortMappings` so NodePorts surface on `localhost` for host-side k6 and the browser.
(`k3d`/`minikube` are acceptable alternatives; the manifests are portable.) A `kind-config.yaml`
maps: `30847→8473` (ingest), `30848→8474` (Grafana), `30909→9090` (Prometheus remote-write).

---

## 2. Refactor phases

### Phase 1 — Containerize and lift the stack into K8s

**New files**

- `server/Dockerfile` — `node:20-slim`, copy `server/`, `npm ci --omit=dev`, run
  `node src/server.js`. The image also carries the migration and CronJob scripts (see below),
  so one image serves the Deployment **and** both CronJobs (different `command`s).
- `k8s/` (kustomize base) with:
  - `namespace.yaml` — `invos`.
  - `postgres-statefulset.yaml` + `postgres-svc.yaml` + PVC — single replica (Postgres is the
    **shared bottleneck on purpose**, not scaled). Credentials from a `Secret`
    (`invos`/`devonly`/`invoices`), matching `server/src/db.js` defaults.
  - `ingest-deployment.yaml` — env `DATABASE_URL=postgres://…@postgres:5432/invoices`,
    `readinessProbe`/`livenessProbe` → `GET /healthz`, **resource requests/limits set**
    (critical for HPA, see Phase 2), `replicas: 1` (HPA owns it afterward).
  - `ingest-svc.yaml` — ClusterIP + a NodePort (`30847`) so host k6 reaches it.
  - `migrate-job.yaml` — a `Job` running `node scripts/migrate.js` as an init step on `up`
    (replaces `npm run migrate`). Idempotent migrations make re-runs safe.
  - `prometheus-*.yaml` — Deployment + ConfigMap (scrape config rewritten for **Kubernetes SD**:
    discover pods with label `app=invos-ingest`, scrape `:8473/metrics`; scrape
    kube-state-metrics; keep `--web.enable-remote-write-receiver`) + NodePort `30909`.
  - `grafana-*.yaml` — Deployment + ConfigMaps mounting the **existing** provisioning and
    dashboard JSON from `monitoring/grafana/` (reused verbatim; the Postgres datasource URL
    becomes `postgres:5432`, the Prometheus URL `http://prometheus:9090`) + NodePort `30848`.
  - `kube-state-metrics.yaml` — standard deployment + RBAC + service; add to Prometheus scrape.

**Edits**

- `scripts/run.sh`: replace steps 1–5. New `up`: `kind create cluster` (if absent) → build &
  `kind load` the server image → `kubectl apply -k k8s/` → wait for rollout → run the migrate
  Job → generate data → prepare k6 feed. New `down`: `kind delete cluster` (and a `WIPE_DATA=1`
  path still drops the PVC if we keep the cluster). `BASE_URL` default stays
  `http://localhost:8473` but now resolves through the kind port mapping.
- `Makefile`: `BASE_URL` unchanged (still `localhost:8473` via NodePort). `k6-verify` runs
  `psql` via `kubectl exec` into the Postgres pod instead of `docker compose exec`.
- `monitoring/prometheus/prometheus.yml`: becomes the in-cluster scrape config (k8s SD). Keep
  the original under a comment for the legacy compose path or delete once migrated.
- Compose: `docker-compose.yml` is superseded for the app stack. Keep it only if we want a
  "legacy mode"; otherwise mark deprecated in `README.md`. (Decision: keep it for one release
  as a fallback, note it clearly.)

**New subfolder rule (repo convention):** add `k8s/README.md` describing the manifests and how
to apply them, since `k8s/` is a new top-level folder. Add a `.gitignore` rule for any rendered
manifests / local kubeconfig artifacts.

### Phase 2 — Autoscaling that the stress test drives, visibly

This is the heart of the request. Three sub-parts: the HPA, the load profile that goes **up
and back down**, and the Grafana panel.

**2a. The HPA and its metric**

- `k8s/ingest-hpa.yaml` — `autoscaling/v2`, `minReplicas: 1`, `maxReplicas: 8`, target
  `invos-ingest`.
- **Scaling metric — recommendation: CPU utilization (baseline) with custom RPS as an
  optional upgrade.**
  - *Why CPU is the reliable default:* each healthy request is a 50-item batch that is
    JSON-parsed and **Ajv-validated** plus a consistency reduce — that is genuine CPU work, so
    CPU tracks offered RPS closely. CPU metrics come from **metrics-server**, which is one
    install and always works on kind. Set `requests.cpu` modestly (e.g. `150m`) so a few
    hundred req/s saturate a pod and force scale-out; `averageUtilization: 60`.
  - *Optional "wow" upgrade:* install **prometheus-adapter** and scale on a custom metric —
    requests-per-second per pod derived from `invos_ingest_requests_total`. This is more
    on-message ("scale on offered load", matching the open-model load-test philosophy) but
    adds the `custom.metrics.k8s.io` API and more failure surface. Ship CPU first; add the
    custom metric only if time allows. Document both in `k8s/README.md`.
- **Scale-down tuning for a watchable demo:** HPA's default scale-down stabilization is 300s,
  which makes the shrink slow. Set `behavior.scaleDown.stabilizationWindowSeconds: 30` (and a
  sane `scaleUp` policy) so the cluster visibly shrinks within ~1 min of traffic stopping —
  fast enough to see in one demo run, still damped enough not to flap.

**2b. The Postgres connection consequence (must address, or scaling backfires)**

Horizontally scaling the app **multiplies DB connections**: each pod opens its own pg `Pool`
(default `max: 10`), so 8 pods = up to 80 backend connections, near Postgres' default
`max_connections: 100`. Two mitigations, do both:

- Lower per-pod pool size via env (`PG_POOL_MAX`, e.g. `5`) — small `db.js` edit to read it.
- Add **PgBouncer** as a `Deployment` + `Service` in front of Postgres (transaction pooling);
  point `DATABASE_URL` at PgBouncer. Now N app pods fan into a bounded server-side connection
  set, so scaling the app actually **raises throughput** instead of exhausting Postgres. This
  also turns the documented "p99 breaks ~400 req/s due to pool max:10" bottleneck into a
  *moved* bottleneck — a great before/after talking point. (If time-boxed, ship the pool-size
  env first; PgBouncer is the proper fix.)

**2c. The up-and-down load profile**

Current `loadtest/profiles/stress.js` only ramps **up** and uses `abortOnFail` thresholds that
stop the run at the first broken threshold — so it never comes back down and the shrink is
never exercised. Add a new profile **`loadtest/profiles/scale.js`**:

- `ramping-arrival-rate`, stages that climb in steps **and then descend back to 0**, e.g.
  `0→50→150→300→500` (hold each ~90s) then `500→300→150→50→0` (hold each ~60s), then a couple
  minutes at 0 to watch the floor settle.
- **No `abortOnFail`** (relaxed/observe-only thresholds) so the whole up-down cycle completes;
  the point here is autoscaling behavior, not finding the wall. Keep `stress.js` as-is for the
  "find the wall" story.
- Add `make k6-scale` and `bash scripts/run.sh scale`.

**2d. The Grafana "money panel"**

Add a panel to **System Performance** (`monitoring/grafana/dashboards/system-performance.json`):
**"Autoscaling — replicas vs offered load vs p99"**, three series on a shared time axis:

- `kube_horizontalpodautoscaler_status_current_replicas{horizontalpodautoscaler="invos-ingest"}`
  (or `kube_deployment_status_replicas{deployment="invos-ingest"}`) — the step line that grows
  and shrinks. From kube-state-metrics.
- k6 offered rate — reuse the existing "k6 offered load" series (k6 remote-write `http_reqs`).
- p99 from `invos_ingest_duration_seconds` — reuse the existing latency query.

Optionally a stat panel for current vs desired replicas and a panel for
`kube_pod_status_phase` to show pods going `Pending→Running`. This panel is the deliverable that
makes "grow and shrink, triggered by traffic" **visible**.

---

## 3. Feature — Lottery Checker (對獎)

**User value:** "Tell me which of my invoices won the bimonthly lottery and how much."
**K8s role:** a scalable read route (covered by the same ingest Deployment + HPA) **and** a
bimonthly **CronJob** that imports the draw and precomputes winners.

### 3a. Data pipeline (no change to invoice modality)

The invoice side already carries everything (`invoice_number`, `invoice_date`). What is new is
a **sibling dataset** — the winning numbers — plus a precomputed winners table.

- **Migration `db/migrations/003_lottery.sql`:**
  - `lottery_draws(period TEXT PRIMARY KEY, drawn_on DATE, special CHAR(8), grand CHAR(8),
    first JSONB /* 3× 8-digit */, additional JSONB /* extra 3-digit numbers */)`.
  - `lottery_winners(id BIGSERIAL PK, period TEXT, invoice_id BIGINT REFERENCES invoices(id),
    carrier_id TEXT, prize_tier TEXT, amount INTEGER, UNIQUE(period, invoice_id))` — the
    precomputed result the API reads. Index on `(carrier_id, period)`.
- **Prize rules** (encode in the matching SQL/JS): special & grand match all 8 digits
  (10,000,000 / 2,000,000); each first-prize number matches all 8 → 200,000, last 7 → 40,000,
  last 6 → 10,000, last 5 → 4,000, last 4 → 1,000, last 3 → 200; additional numbers match last
  3 → 200. Match on the 8 numeric digits of `invoice_number`.

### 3b. Generator change — make winners exist in the demo

With random invoice numbers, **nobody ever wins**, so the demo is dead. Add a generator
subcommand that **derives the draw from the generated invoices** so a known fraction win:

- `uv run python -m generator draw --in data/invoices_90d.ndjson --out data/draw.json
  --period 2026-05/06 --winners 0.01` — reads emitted invoice numbers, picks real ones to be
  the special/grand/first numbers, and (by truncating suffixes) guarantees ~1% of carriers hold
  a winning suffix. Deterministic under the same seed. Implemented in `generator/generator/`
  (`draw.py` + a subparser in `__main__.py`).
- This requires **no change to the invoice schema** — only a second generator output file and a
  loader.

### 3c. Server + CronJob

- **New route** in a new `server/src/routes/lottery.js` (registered in `app.js`):
  - `GET /api/lottery/check?carrier=…&period=…` → read `lottery_winners` for that carrier/period
    (fast indexed read; served by the autoscaled Deployment).
  - `GET /api/lottery/draws` → list known periods (for the UI/demo).
- **Draw loader / matcher** `server/scripts/lottery-draw.js`: upsert a draw (from `draw.json`
  or args) into `lottery_draws`, then run one `INSERT … SELECT` that scans the period's invoices,
  computes the tier, and populates `lottery_winners` (`ON CONFLICT DO NOTHING`, so re-runs are
  idempotent — consistent with the project's idempotency ethos).
- **CronJob `k8s/cron-lottery.yaml`:** runs `node scripts/lottery-draw.js` on a bimonthly
  schedule (e.g. `0 6 25 1,3,5,7,9,11 *`). For the demo we also run it once during `up` (or via
  `make lottery-draw`) so winners exist immediately.
- **Metric:** `invos_lottery_winners_total{tier}` counter incremented by the matcher, surfaced
  on the Invoice Analytics dashboard.

### 3d. Tests

- Generator: `draw` produces a draw whose numbers are a subset of input invoice numbers, and
  the winners fraction is in range (deterministic seed).
- Server: matcher assigns the right tier for crafted suffixes (200k/40k/.../200), and
  `/api/lottery/check` returns them; idempotent re-run adds no duplicate winners.

---

## 4. Feature — Warranty / Return Reminder

**User value:** "Remind me before a product's return window or warranty is about to end."
**K8s role:** the textbook **CronJob** — a daily scan that materializes reminders.
This is the feature with the **biggest data-modality change**, so trace it end to end.

### 4a. Data pipeline (items gain attributes — full pipeline ripple)

1. **Generator config (`generator/config.yaml`)** — add durable categories and per-category
   windows. Existing categories (snacks/beverages/…) get **no** warranty. Add e.g.:
   ```yaml
   electronics:      { price_min: 500, price_max: 8000, warranty_months: 12, return_days: 7,
                       descriptions: ["Earbuds","Power Bank","USB-C Charger","BT Speaker"] }
   small_appliances: { price_min: 800, price_max: 6000, warranty_months: 24, return_days: 7,
                       descriptions: ["Electric Kettle","Hair Dryer","Toaster"] }
   ```
2. **Generator (`invoices.py`)** — `_make_item` emits `warranty_months` and `return_days` when
   the category spec defines them, else omits/`null`. Keep determinism.
3. **Validation (`server/src/schemas/invoice.schema.js`)** — add **optional** `warranty_months`
   `{type:['integer','null'], minimum:0}` and `return_days` to the `item` schema. **Critical:**
   the app runs `removeAdditional:false`, so unknown fields are *rejected* — these MUST be added
   to the schema or every new payload 400s. One edit covers both validators (Fastify's Ajv and
   the standalone Ajv in `ingest.js` share this schema object).
4. **Migration `db/migrations/004_warranty.sql`** — add to `invoice_items`:
   `warranty_months INT NULL`, `return_days INT NULL`. (Compute the due dates in the scan query
   from the parent's `invoice_date`; keep raw windows in the row.) Index to support the scan:
   `idx_invoice_items_warranty` on `(return_days)` partial `WHERE return_days IS NOT NULL`, plus
   we already have `idx_invoices_invoice_date`.
5. **Insert (`server/src/ingest.js insertInvoice`)** — extend the items INSERT to carry the two
   new columns (bump the per-row param stride from 7 to 9). Mirror how `brand` is handled
   (nullable, defaulted).

### 4b. The demo-visibility problem (and its fix)

The generator dates everything **today**, and the k6 layer **re-stamps `invoice_date` to today**
at emit time. So every return window = `today + return_days`, always in the future → the daily
scan would find **nothing due**, and the feature looks dead in a fresh `up`.

**Fix — a historical seed loaded directly (not via k6):**

- Add a generator mode `--history-days 30` (or a `history` subcommand) that produces invoices
  with `invoice_date` spread across the **past** ~30 days, including durable items whose return
  windows therefore fall due **around today**. Output `data/invoices_history.ndjson`.
- `scripts/run.sh up` loads this seed **through the ingest API** (a small `server/scripts/seed.js`
  POSTing batches, or `make seed`). Because it goes through the API directly — not k6 — the past
  dates are preserved (k6 is the only thing that re-stamps to today). Live k6 traffic stays
  "today"; only this seed is historical. This is the one deliberate exception to the "always
  today" rule, and it exists precisely so the warranty CronJob has real due items on day one.

### 4c. Server + CronJob

- **Migration `004_warranty.sql`** also adds
  `warranty_reminders(id BIGSERIAL PK, carrier_id TEXT, invoice_id BIGINT, item_id BIGINT,
  kind TEXT /* return|warranty */, due_date DATE, created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(item_id, kind))`.
- **Scan script `server/scripts/warranty-scan.js`:** one `INSERT … SELECT … ON CONFLICT DO
  NOTHING` that finds items whose return window (`invoice_date + return_days`) or warranty end
  (`invoice_date + warranty_months`) falls within a configurable look-ahead (e.g. next 3 days /
  next 14 days) and upserts reminders. Idempotent.
- **CronJob `k8s/cron-warranty.yaml`:** runs `node scripts/warranty-scan.js` daily
  (e.g. `0 7 * * *`). Run once during `up` so reminders exist for the demo.
- **New route `server/src/routes/reminders.js`** (registered in `app.js`):
  `GET /api/reminders?carrier=…` → upcoming reminders for that carrier.
- **Metric:** `invos_warranty_reminders_due{kind}` gauge set by the scan; panel on a dashboard
  ("reminders due by day / by kind").

### 4d. Tests

- Generator: durable items carry `warranty_months`/`return_days`; non-durable items don't;
  `history` mode produces past-dated invoices.
- Server: schema now **accepts** the new fields (and still rejects unknown ones); `insertInvoice`
  persists them; the scan upserts exactly the items inside the look-ahead window and is
  idempotent on re-run.

---

## 5. Data-pipeline impact summary

| Stage | Lottery Checker | Warranty Reminder |
|---|---|---|
| Generator output | New `draw` subcommand → `draw.json` (no invoice change) | New item fields + `history` mode (past dates) |
| Ajv schema | unchanged | **add** optional `warranty_months`, `return_days` (must, due to `removeAdditional:false`) |
| Migrations | `003_lottery.sql` (draws, winners) | `004_warranty.sql` (item cols, reminders) |
| Ingest insert | unchanged | extend items INSERT (stride 7→9) |
| New endpoints | `/api/lottery/check`, `/api/lottery/draws` | `/api/reminders` |
| K8s primitive | CronJob (draw+match) + scaled read Deployment | CronJob (daily scan) |
| Demo seeding | run matcher once on `up` | load historical seed on `up` |
| New metric | `invos_lottery_winners_total{tier}` | `invos_warranty_reminders_due{kind}` |

---

## 6. Risks & considerations

- **DB connection multiplication** under autoscaling (§2b) — the single most important
  correctness risk; mitigate with per-pod pool size + PgBouncer, else scaling exhausts Postgres.
- **HPA flapping** — tune `behavior` stabilization windows; pick a metric that moves smoothly
  with load (CPU does, given the validation work).
- **Image distribution on kind** — must `kind load docker-image` after every rebuild; bake this
  into `run.sh` (a stale image is the classic "my fix didn't apply" trap).
- **ufw / bridge→host** — the existing scrape caveat (`monitoring/README.md`,
  `env-local-monitoring.md`) changes shape: Prometheus now scrapes **inside** the cluster, so the
  host-gateway issue goes away, but host k6 → NodePort and host k6 remote-write → Prometheus
  NodePort are the new host↔cluster hops to verify.
- **Generator determinism** — `draw` and `history` modes must stay seed-deterministic so tests
  and demos are reproducible.
- **Scope control** — CPU-based HPA + pool-size env is the minimal viable autoscaling story;
  prometheus-adapter custom metrics and PgBouncer are clearly-marked upgrades, not blockers.

---

## 7. Sequencing & rough effort

1. **Phase 1 — lift to K8s** (M): Dockerfile, manifests, `run.sh` rewrite, Prometheus k8s SD,
   Grafana reprovision. *Gate:* `up` works, dashboards populate, k6 still drives the NodePort.
2. **Phase 2 — autoscaling + visibility** (M): HPA, metrics-server, kube-state-metrics, pool/
   PgBouncer, `scale.js` profile, the money panel. *Gate:* run `scale` and watch pods grow/shrink
   in Grafana. **(Highest-value interview deliverable — do this before the features.)**
3. **Phase 3 — Lottery Checker** (M): migration, generator `draw`, route, matcher, CronJob,
   tests, dashboard. *Gate:* `/api/lottery/check` returns winners after `up`.
4. **Phase 4 — Warranty Reminder** (M–L): schema/modality change through the whole pipeline,
   `history` seed, scan, CronJob, route, tests, dashboard. *Gate:* `/api/reminders` returns due
   items after `up`.

**Build order recommendation:** Phases 1→2 first (they *are* the "Kubernetes for scalability"
story and the visible autoscaling demo), then the **Lottery Checker** (lowest schema risk,
reuses the autoscaled Deployment), then the **Warranty Reminder** (the deeper pipeline change).

---

## 8. Demo script (target end state)

```bash
bash scripts/run.sh up        # kind up, build+load image, apply manifests, migrate, seed, generate
# Grafana: http://localhost:8474  → "System Performance" → Autoscaling panel
bash scripts/run.sh scale     # ramp up then down; watch replicas grow then shrink
curl "localhost:8473/api/lottery/check?carrier=/A1B2C3D&period=2026-05/06"
curl "localhost:8473/api/reminders?carrier=/A1B2C3D"
bash scripts/run.sh down      # kind delete cluster (WIPE_DATA=1 drops the PVC)
```
