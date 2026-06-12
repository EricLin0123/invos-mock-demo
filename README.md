# invos-mock-demo — Sequential Agent Prompts (Index)

Five self-contained prompts for a coding agent. Feed them **one at a time, in order**; verify each step's acceptance criteria yourself before starting the next.

| Step | File | Delivers |
|---|---|---|
| 1 | `step-1-server-and-database.md` | Fastify server + Dockerized PostgreSQL + invoice schema + migrations + health check |
| 2 | `step-2-data-generation.md` | Python/Faker generator: deterministic NDJSON invoices, household model, optional campaign effect with ground truth |
| 3 | `step-3-ingestion.md` | Validated, idempotent, transactional ingest endpoints + metrics + replay script |
| 4 | `step-4-k6-load-testing.md` | k6 smoke/load/stress/soak profiles, thresholds, malformed-traffic injection, DB verification |
| 5 | `step-5-grafana-monitoring.md` | Prometheus + Grafana provisioned as code: system dashboard + invoice analytics dashboard (campaign lift visible), demo script, cleanup guide |

## Usage tips

- Each prompt has Context / Goal / Tasks / Acceptance criteria / Out of scope. The "out of scope" lines stop the agent from sprinting ahead.
- The toolchain is fixed: Docker (OrbStack), k6, uv — plus Node and Python *inside* the project. kind/kubectl/helm from the original toolchain list are NOT used in these five steps (the project stays on Docker Compose); keep them uninstalled unless you later extend to Kubernetes.
- Between steps, commit. If the agent deviates from the structure or adds dependencies beyond the prompt, push back — minimalism is part of the demo.
- The thread connecting everything: generator (Step 2) plants a campaign effect → ingest (Step 3) stores it idempotently → k6 (Step 4) proves the pipeline under load → Grafana (Step 5) makes both the system's health and the planted effect visible.
