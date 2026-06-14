# Mock Invoice Data Generator

A simple, deterministic generator of mock Taiwanese e-invoice data. It writes
**NDJSON files only** (one invoice per line) — no database, no network. The ingestion
API consumes these files (replay) and k6 draws load batches from them.

Python 3.12, managed by [`uv`]. Only dependency: `pyyaml`.

## Quickstart

```bash
cd generator && uv sync
uv run python -m generator --seed 42 --count 100000 --out data/invoices_90d.ndjson
```

Output is sorted ascending by `invoice_date`. Same `--seed` + same `config.yaml` ⇒
byte-identical output.

CLI flags:

| Flag       | Default                        | Meaning                                       |
|------------|--------------------------------|-----------------------------------------------|
| `--config` | `config.yaml`                  | path to the parameter file                    |
| `--out`    | `data/invoices_90d.ndjson`     | output NDJSON path                            |
| `--seed`   | `config.seed` (42)             | RNG seed; same seed + config ⇒ identical output |
| `--count`  | `config.count` (100000)        | number of invoices to generate                |

## NDJSON schema

Each line is one JSON object matching the ingestion API's invoice schema
(`server/src/schemas/invoice.schema.js`). Keys are emitted sorted for reproducible bytes.

| Field            | Type           | Notes                                                       |
|------------------|----------------|-------------------------------------------------------------|
| `invoice_number` | string         | 2 uppercase letters + 8 digits (`AB12345678`).              |
| `invoice_date`   | string (date)  | `YYYY-MM-DD`. Always today (the run date); the k6 load test re-stamps it at emit time. |
| `random_code`    | string         | 4 digits.                                                   |
| `seller_tax_id`  | string         | 8-digit seller number (from `config.sellers`).              |
| `seller_name`    | string         | Seller display name (from `config.sellers`).                |
| `carrier_id`     | string \| null | Consumer key: `/`+7 chars from a fixed population of `users`; null for ~`anonymous_rate` of invoices. |
| `total_amount`   | integer        | NTD (no cents) = sum of item `amount`.                      |
| `items`          | array\<item\>  | `items_min`–`items_max` line items.                         |

Each `items[]` element:

| Field        | Type           | Notes                                          |
|--------------|----------------|------------------------------------------------|
| `description`| string         | Product description (from the commodity catalog). |
| `category`   | string         | Commodity type, e.g. `snacks`, `beverages`, `produce` (picked uniformly at random). |
| `quantity`   | integer        | `quantity_min`–`quantity_max`.                 |
| `unit_price` | integer        | NTD per unit (per-category price range).       |
| `amount`     | integer        | `unit_price × quantity`.                        |

## Configuration

All knobs live in [`config.yaml`] (every field is commented): `count`, `users` (size of the
consumer population) and `anonymous_rate`, item/quantity ranges, the `sellers` list, and the
`commodities` catalog (category → price range, descriptions). Add or remove commodities to
vary the product mix.

## Determinism

A single seeded `random.Random` drives all numeric randomness, so the same `--seed` +
config produce identical invoices within a run (verified by a hash-equal test). The only
non-seeded field is `invoice_date`, which is always the current run date.

## Tests

```bash
cd generator && uv run --extra test pytest
```

Covers: count matches config, determinism (incl. hash-equal files), totals add up,
dated-today (no multi-month spread), no brand field, schema-field validity, and the CLI
writing a file.

[`uv`]: https://docs.astral.sh/uv/
[`config.yaml`]: ./config.yaml
