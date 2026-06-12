# invos-mock-demo — Step 2: Mock Invoice Data Generation (Python + Faker)

## Context

Step 1 delivered a Fastify server + PostgreSQL with the invoice schema. Now build the data generator that produces statistically meaningful mock Taiwanese e-invoice data. The generator only writes **files** (NDJSON); it never touches the database directly — ingestion happens through the API in Step 3, and k6 replays these files in Step 4.

**Tech constraints:** Python 3.12 managed by `uv` (env lives inside the repo at `generator/.venv`). Libraries: `faker`, `numpy`, `pyyaml` only. No pandas needed unless genuinely simpler.

## Goal of this step

`uv run python -m generator` produces a deterministic, chronologically ordered NDJSON file of invoices whose statistical properties are documented and verifiable — including an optional "ad campaign" effect that later analysis/dashboards can detect.

## Tasks

1. **Scaffold** inside the existing repo:
   ```
   generator/
   ├── pyproject.toml         # uv-managed
   ├── config.yaml            # ALL tunable parameters live here, commented
   ├── generator/
   │   ├── __main__.py        # CLI: --config, --out, --seed
   │   ├── population.py      # households + their habits
   │   ├── invoices.py        # invoice/event generation over simulated days
   │   └── campaign.py        # optional purchase-behavior shift (the "commercial")
   ├── data/                  # output NDJSON (gitignored)
   └── tests/
   ```
2. **Population model** (`population.py`): generate N households (default 5,000), each with:
   - a stable `carrier_id` (`/` + 7 chars from `[0-9A-Z+-.]`) — Faker for names/stores where useful,
   - a shopping frequency multiplier drawn from `Gamma(shape=2, scale=0.5)` (mean 1.0 — creates realistic heavy/light shoppers),
   - a preferred-store list (3–5 stores from a catalog of ~40 stores with fake but format-valid 8-digit seller tax IDs).
3. **Invoice generation** (`invoices.py`), simulating `days` (default 90) of purchases:
   - Daily shopping probability per household = `base_rate × household_multiplier × weekday_factor` (weekends ×1.25).
   - Each shopping trip → one invoice: 1–6 items drawn from a category catalog defined in `config.yaml` — must include `toothpaste` (with 3 named mock brands and per-household brand preference) plus at least 5 other categories (snacks, beverages, instant noodles, shampoo, household goods).
   - Realistic fields matching the Step 1 schema exactly: `invoice_number` (2 letters + 8 digits; letters rotate per bimonthly period), `invoice_date`, `random_code`, `seller_tax_id`, `seller_name`, `carrier_id`, items with integer NTD prices, `total_amount` = sum of item amounts.
   - Output: **one NDJSON line per invoice**, sorted by date, schema documented in `generator/README.md`.
4. **Campaign effect** (`campaign.py`), toggled in `config.yaml`:
   - From `campaign.start_day` (default 45), a configurable fraction (default 40%) of households are "exposed".
   - Exposed households: toothpaste purchase probability ×`lift` (default 1.5) and brand preference shifts toward `campaign.brand`.
   - Write `data/ground_truth.json`: exposed household IDs, start day, lift parameters — so dashboards/analysis can later be checked against truth.
5. **Determinism**: single `--seed` drives one `numpy.random.Generator` and Faker's seed. Same seed + config ⇒ byte-identical output. Add a test for this.
6. **Tests**: determinism; invoice_number format regex; totals add up; campaign actually raises exposed households' toothpaste rate in-sample (statistical test on generated output, e.g., simple two-proportion z-test, assert p < 0.01 at default settings).
7. **README** (`generator/README.md`): NDJSON schema table, how parameters map to behavior, example commands:
   ```bash
   cd generator && uv sync
   uv run python -m generator --seed 42 --out data/invoices_90d.ndjson
   ```

## Acceptance criteria

- Default run produces ~90 days × 5,000 households of invoices in under 60 seconds, chronologically sorted.
- Re-running with the same seed produces an identical file (hash-equal).
- `ground_truth.json` written whenever the campaign is enabled.
- Tests pass, including the statistical campaign-effect test.
- Zero database or network access in this module.

## Out of scope

No HTTP posting (Step 3/4), no plotting, no Postgres.
