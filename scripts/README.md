# scripts — repo-level helper scripts

## run.sh

The main entry point: bring the **Kubernetes (kind)** stack up, then run any of the five k6
tests.

```bash
bash scripts/run.sh up                              # kind cluster + image + manifests + migrate + generate
bash scripts/run.sh smoke|load|stress|scale|soak    # run that k6 profile (Prometheus overlay ON)
bash scripts/run.sh down                             # delete the cluster (WIPE_DATA=1 too — PVC goes with it)
```

Env knobs: `COUNT` (invoices to generate on `up`, default `100000`), `SEED` (default `42`),
`BASE_URL` (default `http://localhost:8473`), `CLUSTER` (kind cluster name, default `invos`),
`IMAGE` (server image tag, default `invos-ingest:dev`). `up` builds + `kind load`s the server
image and applies `k8s/`; there is no host server process. Prerequisites on PATH: `docker`,
`kind`, `kubectl`, `node`, `uv`, `k6`. See `k8s/README.md` for the manifests and the
autoscaling demo (`scale`).

## demo.sh (legacy / compose)

> ⚠️ **Deprecated.** `demo.sh` and `stop-demo.sh` drive the old docker-compose path with the
> Fastify server on the host. They are kept for one release as a fallback; prefer
> `scripts/run.sh` (Kubernetes), which is what supports the autoscaling story.


The end-to-end demo path. From a fresh checkout it brings up the stack, migrates, generates
invoices (with the ad campaign on), replays them into the API, runs a k6 profile with
Prometheus remote-write, and prints the Grafana URLs and what to look at.

```bash
bash scripts/demo.sh                 # quick path: smoke profile (~1 min of k6)
K6_PROFILE=load bash scripts/demo.sh # watch the system dashboard under sustained load (~12 min)
SKIP_K6=1 bash scripts/demo.sh       # just bring the stack up and replay, no k6
```

Env knobs: `K6_PROFILE` (default `smoke`), `SKIP_K6=1`, `SEED` (default `42`),
`BASE_URL` (default `http://localhost:8473`).

Prerequisites on PATH: `docker`, `node`, `uv`, and `k6`. The Fastify server is started on the
host (not in compose); its pid is written to `/tmp/invos-server.pid` and logs to
`/tmp/invos-server.log`.

## stop-demo.sh

The inverse of `demo.sh`. Terminates everything the demo started — the host ingestion server
(via `/tmp/invos-server.pid`, falling back to whatever is listening on `:8473`), any running
k6, and the Docker Compose stack.

```bash
bash scripts/stop-demo.sh             # stop processes + `docker compose down`, KEEP data volumes
WIPE_DATA=1 bash scripts/stop-demo.sh # also remove the volumes (docker compose down -v) — clean slate
```

Env knobs: `WIPE_DATA=1` (remove named volumes), `BASE_URL` (default `http://localhost:8473`).

> Note: per-component scripts live with their component — schema migration and NDJSON replay
> are in `server/scripts/` (run via `npm run migrate` / `npm run replay`).
