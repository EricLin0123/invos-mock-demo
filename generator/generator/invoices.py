# invoices.py — simple, deterministic mock e-invoice generator.
#
# Produces a flat list of invoice dicts matching the ingestion API's schema exactly
# (see server/src/schemas/invoice.schema.js). No households, campaigns, brands, or
# statistical modelling — just N invoices with random sellers, commodities, quantities
# and prices. The invoice_date is always "today" (the run date): invoices are never
# spread across months. A single seeded random.Random drives the numeric randomness, so
# the same seed + config yields identical numbers run-to-run.

import random
import string
from datetime import date

_UPPER = string.ascii_uppercase
_DIGITS = string.digits
_CARRIER_CHARS = string.ascii_uppercase + string.digits


def _invoice_number(rng: random.Random) -> str:
    """2 uppercase letters + 8 digits, e.g. AB12345678."""
    letters = "".join(rng.choices(_UPPER, k=2))
    digits = "".join(rng.choices(_DIGITS, k=8))
    return letters + digits


def _random_code(rng: random.Random) -> str:
    return "".join(rng.choices(_DIGITS, k=4))


def _make_carrier(rng: random.Random) -> str:
    """A mobile-barcode carrier id: '/' + 7 chars. One per consumer (stable user key)."""
    return "/" + "".join(rng.choices(_CARRIER_CHARS, k=7))


def _make_item(category: str, spec: dict, rng: random.Random,
               quantity_min: int, quantity_max: int) -> dict:
    """One line item: pick a description, draw quantity and unit price, derive amount."""
    quantity = rng.randint(quantity_min, quantity_max)
    unit_price = rng.randint(spec["price_min"], spec["price_max"])
    return {
        "description": rng.choice(spec["descriptions"]),
        "category": category,
        "quantity": quantity,
        "unit_price": unit_price,
        "amount": quantity * unit_price,
    }


def generate(cfg: dict, seed: int) -> list[dict]:
    """Generate cfg['count'] invoices deterministically from `seed`.

    Every invoice is dated today (the run date); downstream emitters may re-stamp the
    date at send time. Returns a list of invoice dicts.
    """
    rng = random.Random(seed)
    today = date.today().isoformat()

    count = int(cfg["count"])
    items_min = int(cfg["items_min"])
    items_max = int(cfg["items_max"])
    quantity_min = int(cfg["quantity_min"])
    quantity_max = int(cfg["quantity_max"])
    anonymous_rate = float(cfg.get("anonymous_rate", 0.10))

    sellers = cfg["sellers"]
    commodities = cfg["commodities"]
    categories = list(commodities.keys())

    # A fixed population of consumers, each with a stable carrier_id (the user key).
    # Invoices are assigned to a random user, so "distinct carrier_id" = users seen.
    users = [_make_carrier(rng) for _ in range(int(cfg["users"]))]

    invoices: list[dict] = []
    for _ in range(count):
        seller = rng.choice(sellers)
        carrier_id = None if rng.random() < anonymous_rate else rng.choice(users)
        n_items = rng.randint(items_min, items_max)
        items = [
            _make_item(cat := rng.choice(categories), commodities[cat], rng,
                       quantity_min, quantity_max)
            for _ in range(n_items)
        ]
        invoices.append({
            "invoice_number": _invoice_number(rng),
            "invoice_date": today,
            "random_code": _random_code(rng),
            "seller_tax_id": seller["tax_id"],
            "seller_name": seller["name"],
            "carrier_id": carrier_id,
            "total_amount": sum(it["amount"] for it in items),
            "items": items,
        })
    return invoices
