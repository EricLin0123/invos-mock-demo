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


def _carrier_id(rng: random.Random) -> str | None:
    """Mobile-barcode carrier '/'+7 chars; ~30% of invoices carry none (null)."""
    if rng.random() < 0.30:
        return None
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

    sellers = cfg["sellers"]
    commodities = cfg["commodities"]
    categories = list(commodities.keys())

    invoices: list[dict] = []
    for _ in range(count):
        seller = rng.choice(sellers)
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
            "carrier_id": _carrier_id(rng),
            "total_amount": sum(it["amount"] for it in items),
            "items": items,
        })
    return invoices
