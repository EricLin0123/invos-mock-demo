# Makefile — convenience targets for the k6 load test (Step 4).
# Run from the repo root: `make k6-smoke`, `make k6-load`, `make k6-stress`, `make k6-soak`.
#
# All targets cd into loadtest/ first so k6's open() resolves the data file relative to the
# profiles, exactly as it does when you run k6 by hand from loadtest/.

K6      ?= k6
NODE    ?= node
BASE_URL ?= http://localhost:8473

# Optional Prometheus remote-write output (Step 5). It is OFF by default so every profile
# runs standalone today. Turn it on by setting K6_PROM=1, which appends the output flag;
# point it at your Prometheus with K6_PROMETHEUS_RW_SERVER_URL.
K6_PROMETHEUS_RW_SERVER_URL ?= http://localhost:9090/api/v1/write
PROM_OUT := $(if $(K6_PROM),-o experimental-prometheus-rw,)

export BASE_URL
export K6_PROMETHEUS_RW_SERVER_URL

.PHONY: k6-prepare k6-smoke k6-load k6-stress k6-soak k6-verify

# Convert the Step-2 NDJSON into loadtest/data/chunks.json (run once before the profiles).
k6-prepare:
	$(NODE) loadtest/prepare.js

k6-smoke: k6-data
	cd loadtest && $(K6) run $(PROM_OUT) profiles/smoke.js

k6-load: k6-data
	cd loadtest && $(K6) run $(PROM_OUT) profiles/load.js

k6-stress: k6-data
	cd loadtest && $(K6) run $(PROM_OUT) profiles/stress.js

k6-soak: k6-data
	cd loadtest && $(K6) run $(PROM_OUT) profiles/soak.js

# Post-run database consistency checks.
k6-verify:
	docker compose exec -T postgres psql -U invos -d invoices -f - < loadtest/verify.sql

# Internal: ensure the prepared data file exists before running a profile.
k6-data:
	@test -f loadtest/data/chunks.json || $(MAKE) k6-prepare
