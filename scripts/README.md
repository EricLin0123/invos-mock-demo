# scripts — repo-level helper scripts

## demo.sh

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
`/tmp/invos-server.log`. Stop it with `kill $(cat /tmp/invos-server.pid)`.

> Note: per-component scripts live with their component — schema migration and NDJSON replay
> are in `server/scripts/` (run via `npm run migrate` / `npm run replay`).
