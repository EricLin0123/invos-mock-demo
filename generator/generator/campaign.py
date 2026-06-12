# campaign.py — the optional "ad campaign" purchase-behavior shift.
# Decides which households are exposed and how their toothpaste behavior changes
# after the campaign start day. Also produces the ground-truth record so later
# analysis/dashboards can be checked against the simulated truth.
from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from .population import Population


@dataclass
class Campaign:
    """Resolved campaign parameters plus the exposure mask for this run."""

    enabled: bool
    start_day: int
    lift: float
    brand_index: int          # index into Population.brands of the promoted brand
    brand_shift: float        # 0..1 strength of the preference shift
    exposed: np.ndarray       # bool mask, shape (n,): which households are exposed


def assign_campaign(cfg: dict, rng: np.random.Generator, pop: Population) -> Campaign:
    """Pick exposed households and resolve campaign parameters from config."""
    ccfg = cfg["campaign"]
    n = pop.size
    enabled = bool(ccfg["enabled"])

    if enabled:
        # Randomly mark `exposed_fraction` of households as campaign-exposed.
        n_exposed = int(round(n * ccfg["exposed_fraction"]))
        idx = rng.choice(n, size=n_exposed, replace=False)
        exposed = np.zeros(n, dtype=bool)
        exposed[idx] = True
        brand_index = pop.brands.index(ccfg["brand"])
    else:
        exposed = np.zeros(n, dtype=bool)
        brand_index = 0

    return Campaign(
        enabled=enabled,
        start_day=int(ccfg["start_day"]),
        lift=float(ccfg["lift"]),
        brand_index=brand_index,
        brand_shift=float(ccfg["brand_shift"]),
        exposed=exposed,
    )


def shifted_brand_weights(pop: Population, campaign: Campaign) -> np.ndarray:
    """Return a (n, n_brands) copy of brand weights with exposed households shifted.

    Exposed households move a `brand_shift` fraction of their probability mass onto
    the promoted brand; everyone else keeps their original preference.
    """
    weights = pop.brand_weights.copy()
    if not campaign.enabled or campaign.brand_shift <= 0:
        return weights

    exposed = campaign.exposed
    s = campaign.brand_shift
    b = campaign.brand_index
    # Scale everything down by (1-s), then add s onto the promoted brand.
    weights[exposed] *= (1.0 - s)
    weights[exposed, b] += s
    return weights


def is_campaign_active(campaign: Campaign, day: int, household: int) -> bool:
    """True if the campaign affects this household on this simulated day."""
    return (
        campaign.enabled
        and day >= campaign.start_day
        and bool(campaign.exposed[household])
    )


def build_ground_truth(cfg: dict, pop: Population, campaign: Campaign) -> dict:
    """Serializable ground-truth describing the injected campaign effect."""
    ccfg = cfg["campaign"]
    exposed_ids = [
        pop.carrier_ids[i] for i in range(pop.size) if campaign.exposed[i]
    ]
    return {
        "enabled": campaign.enabled,
        "start_day": campaign.start_day,
        "start_date": _start_date_for_day(cfg, campaign.start_day),
        "lift": campaign.lift,
        "brand": ccfg["brand"],
        "brand_shift": campaign.brand_shift,
        "exposed_fraction": ccfg["exposed_fraction"],
        "n_households": pop.size,
        "n_exposed": int(campaign.exposed.sum()),
        "exposed_carrier_ids": exposed_ids,
    }


def _start_date_for_day(cfg: dict, day: int) -> str:
    """Resolve the calendar date of a simulated day index (for human-readable truth)."""
    from datetime import date, timedelta

    start = date.fromisoformat(cfg["simulation"]["start_date"])
    return (start + timedelta(days=day)).isoformat()
