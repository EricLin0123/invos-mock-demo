# invoices.py — simulates `days` of household shopping and emits invoice records.
# This is the orchestrator: it wires together population.py and campaign.py and
# returns chronologically ordered invoice dicts matching the Step 1 DB schema.
# It performs NO file or network I/O — __main__.py owns writing.
from __future__ import annotations

from datetime import date, timedelta

import numpy as np
from faker import Faker

from . import campaign as campaign_mod
from .population import build_population

# Uppercase-letter pool for the two-letter invoice-number prefix.
_LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ"


def _bimonthly_prefix(d: date) -> str:
    """Two-letter prefix that rotates per bimonthly period (Jan-Feb, Mar-Apr, ...).

    Real Taiwanese invoice numbers reuse the same prefix within a bimonthly
    period, which is why number alone is not a unique key (see Step 1 schema).
    """
    period = (d.month - 1) // 2          # 0..5 within a year
    index = (d.year * 6 + period) % (26 * 26)
    return _LETTERS[index // 26] + _LETTERS[index % 26]


def _invoice_number(d: date, rng: np.random.Generator) -> str:
    """2 letters (per bimonthly period) + 8 random digits, e.g. AB12345678."""
    digits = "".join(str(x) for x in rng.integers(0, 10, size=8))
    return _bimonthly_prefix(d) + digits


def _random_code(rng: np.random.Generator) -> str:
    """4-digit verification code printed on the receipt."""
    return "".join(str(x) for x in rng.integers(0, 10, size=4))


def _pick_quantity(rng: np.random.Generator, q_values, q_probs) -> int:
    return int(rng.choice(q_values, p=q_probs))


def _make_item(category: str, brand, cfg: dict, rng: np.random.Generator, q_values, q_probs):
    """Build a single line item dict for the given category."""
    ccfg = cfg["categories"][category]
    desc = str(rng.choice(ccfg["descriptions"]))
    unit_price = int(rng.integers(ccfg["price_min"], ccfg["price_max"] + 1))
    quantity = _pick_quantity(rng, q_values, q_probs)
    return {
        "description": desc,
        "category": category,
        "brand": brand,
        "quantity": quantity,
        "unit_price": unit_price,
        "amount": unit_price * quantity,
    }


def generate(cfg: dict, seed: int):
    """Generate the full dataset.

    Returns (invoices, ground_truth):
      * invoices: list of dicts, sorted by invoice_date (chronological).
      * ground_truth: dict describing the campaign, or None when disabled.
    A single numpy Generator drives all randomness so that the same seed + config
    yields byte-identical output once serialized.
    """
    rng = np.random.default_rng(seed)
    faker = Faker()
    Faker.seed(seed)

    pop = build_population(cfg, rng, faker)
    campaign = campaign_mod.assign_campaign(cfg, rng, pop)
    brand_weights = campaign_mod.shifted_brand_weights(pop, campaign)

    scfg = cfg["simulation"]
    pcfg = cfg["purchase"]
    start_date = date.fromisoformat(scfg["start_date"])
    days = scfg["days"]
    base_rate = scfg["base_rate"]
    weekend_factor = scfg["weekend_factor"]
    items_min, items_max = pcfg["items_min"], pcfg["items_max"]
    tp_base = pcfg["toothpaste_base_prob"]

    # Pre-resolve quantity distribution (keys are strings in YAML).
    q_values = np.array([int(k) for k in pcfg["quantity_weights"]], dtype=int)
    q_probs = np.array(list(pcfg["quantity_weights"].values()), dtype=float)
    q_probs = q_probs / q_probs.sum()

    # Non-toothpaste category sampling distribution.
    other_categories = list(cfg["category_weights"].keys())
    other_weights = np.array(list(cfg["category_weights"].values()), dtype=float)
    other_weights = other_weights / other_weights.sum()

    n = pop.size
    invoices: list[dict] = []

    for d in range(days):
        current = start_date + timedelta(days=d)
        weekend = current.weekday() >= 5  # 5=Sat, 6=Sun
        wf = weekend_factor if weekend else 1.0

        # Vectorized daily shopping decision for all households at once.
        probs = np.clip(base_rate * pop.multipliers * wf, 0.0, 1.0)
        draws = rng.random(n)
        shoppers = np.nonzero(draws < probs)[0]

        for h in int_iter(shoppers):
            # Pick one preferred store for this trip.
            store_idx = int(rng.choice(pop.preferred_stores[h]))
            n_items = int(rng.integers(items_min, items_max + 1))

            # Toothpaste decision (separately controllable so the campaign is testable).
            tp_prob = tp_base
            if campaign_mod.is_campaign_active(campaign, d, h):
                tp_prob = min(tp_prob * campaign.lift, 1.0)

            items = []
            if rng.random() < tp_prob:
                brand_idx = int(rng.choice(len(pop.brands), p=brand_weights[h]))
                items.append(
                    _make_item("toothpaste", pop.brands[brand_idx], cfg, rng, q_values, q_probs)
                )

            # Remaining items from the non-toothpaste catalog.
            while len(items) < n_items:
                cat = str(rng.choice(other_categories, p=other_weights))
                items.append(_make_item(cat, None, cfg, rng, q_values, q_probs))

            total = sum(it["amount"] for it in items)
            invoices.append(
                {
                    "invoice_number": _invoice_number(current, rng),
                    "invoice_date": current.isoformat(),
                    "random_code": _random_code(rng),
                    "seller_tax_id": pop.store_tax_ids[store_idx],
                    "seller_name": pop.store_names[store_idx],
                    "carrier_id": pop.carrier_ids[h],
                    "total_amount": total,
                    "items": items,
                }
            )

    # Already produced in day order; sort defensively to guarantee chronological output.
    invoices.sort(key=lambda inv: inv["invoice_date"])

    ground_truth = (
        campaign_mod.build_ground_truth(cfg, pop, campaign) if campaign.enabled else None
    )
    return invoices, ground_truth


def int_iter(arr: np.ndarray):
    """Yield Python ints from a numpy index array (readability helper)."""
    for x in arr:
        yield int(x)
