# invos-mock-demo — Mock Invoice Data Generator (Step 2)

Deterministic generator of statistically meaningful mock Taiwanese e-invoice data.
It writes **NDJSON files only** — no database, no network (ingestion happens later
via the API in Step 3, and k6 replays these files in Step 4).

Python 3.12, managed by [`uv`]. Dependencies: `faker`, `numpy`, `pyyaml`, `pyarrow`
(`pyarrow` powers the Parquet cache).

## Quickstart

```bash
cd generator && uv sync
uv run python -m generator --seed 42 --out data/invoices_90d.ndjson
```

This produces `data/invoices_90d.ndjson` (one invoice per line, sorted by date)
and, when the campaign is enabled, `data/ground_truth.json` next to it.

CLI flags:

| Flag           | Default                  | Meaning                                            |
|----------------|--------------------------|----------------------------------------------------|
| `--config`     | `config.yaml`            | path to the parameter file                         |
| `--out`        | `data/invoices.ndjson`   | output NDJSON path (`ground_truth.json` goes here too) |
| `--seed`       | `config.seed` (42)       | RNG seed; same seed + config ⇒ byte-identical output |
| `--cache-dir`  | `data/cache`             | directory holding the Parquet cache                |
| `--regenerate` | off                      | force regeneration, overwriting the cache          |
| `--no-cache`   | off                      | never read or write the cache (in-memory only)     |

## Parquet cache

Generation is deterministic but takes ~18s for the default run, so results are
cached as Parquet keyed by a hash of **(config + seed)**.

- **Default — use the cache.** If an entry exists for the current config+seed, the
  invoices are reloaded from Parquet (the NDJSON is still rewritten from them), so
  a warm run is ~4×–5× faster. Any change to the config or seed changes the key, so
  a stale cache is never silently reused.
- **`--regenerate`** forces fresh generation and overwrites the cache entry.
- **`--no-cache`** bypasses the cache entirely (handy for one-off experiments).

Each cache entry is two files under `--cache-dir`: `<key>.parquet` (invoices, with
line items stored as a nested `list<struct>`) and `<key>.gt.json` (the campaign
ground truth, omitted when the campaign is off). The cache is gitignored.
Reloading from cache yields byte-identical NDJSON to direct generation.

## NDJSON schema

Each line is one JSON object matching the Step 1 `invoices` + `invoice_items`
tables. Keys are emitted in sorted order for reproducible byte output.

| Field            | Type            | Notes                                                            |
|------------------|-----------------|------------------------------------------------------------------|
| `invoice_number` | string          | 2 uppercase letters + 8 digits (`AB12345678`). Letters rotate per **bimonthly** period — so number alone is not unique. |
| `invoice_date`   | string (date)   | `YYYY-MM-DD`. Output is sorted ascending by this field.          |
| `random_code`    | string          | 4 digits.                                                        |
| `seller_tax_id`  | string          | 8-digit seller unified business number (format-valid, fake).     |
| `seller_name`    | string          | Seller display name (Faker company).                             |
| `carrier_id`     | string          | Mobile-barcode carrier: `/` + 7 chars from `[0-9A-Z+-.]`. Stable per household. |
| `total_amount`   | integer         | Invoice total in NTD (no cents) = sum of item `amount`.          |
| `items`          | array\<item\>   | 1–6 line items (see below).                                      |

Each `items[]` element:

| Field        | Type            | Notes                                              |
|--------------|-----------------|----------------------------------------------------|
| `description`| string          | Product description.                               |
| `category`   | string          | `toothpaste`, `snacks`, `beverages`, `instant_noodles`, `shampoo`, `household_goods`. |
| `brand`      | string \| null  | Set for `toothpaste` (one of 3 brands); `null` otherwise. |
| `quantity`   | integer         | Units (mostly 1, sometimes 2–3).                   |
| `unit_price` | integer         | NTD per unit (no cents).                           |
| `amount`     | integer         | `unit_price × quantity`.                            |

### ground_truth.json

Written whenever `campaign.enabled` is true. Records the injected effect so later
analysis/dashboards can be checked against simulated truth: `start_day`,
`start_date`, `lift`, `brand`, `brand_shift`, `exposed_fraction`, counts, and the
full list of `exposed_carrier_ids`.

## How parameters map to behavior

All knobs live in [`config.yaml`] (every field is commented). The model:

- **Population** (`population.py`): N households (default 5,000). Each has a stable
  `carrier_id`, a shopping-frequency multiplier drawn from `Gamma(2, 0.5)`
  (mean 1.0 → a few heavy shoppers, many light ones), 3–5 preferred stores from a
  catalog of 40 sellers, and a toothpaste brand preference.
- **Simulation** (`invoices.py`): over `days` (default 90), each household shops on
  a given day with probability `base_rate × multiplier × weekday_factor`
  (weekends ×1.25, clipped to ≤1). Each trip becomes one invoice with 1–6 items.
- **Toothpaste rate**: an invoice contains a toothpaste line with probability
  `toothpaste_base_prob` (default 0.18) — kept as an explicit knob so the campaign
  effect is clean and testable.
- **Campaign** (`campaign.py`): from `start_day` (default 45), `exposed_fraction`
  (default 40%) of households are exposed. For exposed households on/after the
  start day, toothpaste probability is multiplied by `lift` (default 1.5) and brand
  preference shifts toward `campaign.brand` by `brand_shift`.

## Determinism

A single `numpy.random.Generator` plus a seeded `Faker` drive **all** randomness.
The same `--seed` and config produce byte-identical NDJSON (verified by a test that
hashes two runs).

## Tests

```bash
cd generator && uv sync --extra test
uv run pytest
```

Covers: determinism (incl. hash-equal files), `invoice_number` format, totals add
up, chronological order, schema fields, and a two-proportion z-test asserting the
campaign significantly raises exposed households' toothpaste rate (`p < 0.01`).

## Scope

No HTTP posting (Steps 3/4), no plotting, no Postgres — files only.

[`uv`]: https://docs.astral.sh/uv/
[`config.yaml`]: ./config.yaml
