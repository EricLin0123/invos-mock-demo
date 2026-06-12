# population.py — builds the synthetic household population and the seller catalog.
# Pure data generation: given a config dict, a numpy Generator and a Faker instance,
# it returns a Population describing households and the stores they shop at.
from __future__ import annotations

from dataclasses import dataclass

import numpy as np
from faker import Faker

# Allowed characters for a Taiwanese mobile-barcode carrier id (the part after '/').
_CARRIER_CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ+-."


@dataclass
class Population:
    """Everything about the simulated shoppers and sellers.

    Arrays are indexed by household id (0..n-1) unless noted otherwise.
    """

    carrier_ids: list[str]              # stable '/'+7-char carrier per household
    multipliers: np.ndarray             # shopping-frequency multiplier, shape (n,)
    preferred_stores: list[np.ndarray]  # per household: array of store indices they frequent
    brand_weights: np.ndarray           # toothpaste brand preference, shape (n, n_brands)
    store_names: list[str]              # seller display names, indexed by store id
    store_tax_ids: list[str]            # seller 8-digit tax ids, indexed by store id
    brands: list[str]                   # toothpaste brand names, indexed by brand id

    @property
    def size(self) -> int:
        return len(self.carrier_ids)


def _gen_carrier_id(rng: np.random.Generator) -> str:
    """A carrier id: '/' followed by 7 chars from [0-9A-Z+-.]."""
    idx = rng.integers(0, len(_CARRIER_CHARS), size=7)
    return "/" + "".join(_CARRIER_CHARS[i] for i in idx)


def _gen_tax_id(rng: np.random.Generator) -> str:
    """A format-valid 8-digit seller tax id (unified business number)."""
    digits = rng.integers(0, 10, size=8)
    return "".join(str(d) for d in digits)


def build_store_catalog(cfg: dict, rng: np.random.Generator, faker: Faker):
    """Return (store_names, store_tax_ids) for the seller catalog."""
    n_stores = cfg["population"]["stores_in_catalog"]
    names: list[str] = []
    tax_ids: list[str] = []
    seen: set[str] = set()
    for _ in range(n_stores):
        names.append(faker.company())
        # Ensure tax ids are unique within the catalog.
        tax = _gen_tax_id(rng)
        while tax in seen:
            tax = _gen_tax_id(rng)
        seen.add(tax)
        tax_ids.append(tax)
    return names, tax_ids


def build_population(cfg: dict, rng: np.random.Generator, faker: Faker) -> Population:
    """Generate N households with stable carriers, shopping habits and store/brand preferences."""
    pcfg = cfg["population"]
    n = pcfg["households"]

    store_names, store_tax_ids = build_store_catalog(cfg, rng, faker)
    n_stores = len(store_names)

    # Carrier ids (stable per household for the whole simulation).
    carrier_ids = [_gen_carrier_id(rng) for _ in range(n)]

    # Shopping-frequency multiplier ~ Gamma(shape, scale); mean = shape*scale.
    multipliers = rng.gamma(
        pcfg["frequency_gamma_shape"], pcfg["frequency_gamma_scale"], size=n
    )

    # Preferred store list per household: 3..5 distinct stores from the catalog.
    lo, hi = pcfg["preferred_stores_min"], pcfg["preferred_stores_max"]
    counts = rng.integers(lo, hi + 1, size=n)
    preferred_stores = [
        rng.choice(n_stores, size=int(k), replace=False) for k in counts
    ]

    # Per-household toothpaste brand preference. Start from random Dirichlet-like
    # weights, then sharpen toward a single favorite so households have a real preference.
    brands = list(cfg["categories"]["toothpaste"]["brands"])
    n_brands = len(brands)
    base = rng.random(size=(n, n_brands)) + 0.1
    favorite = rng.integers(0, n_brands, size=n)
    base[np.arange(n), favorite] += 2.0  # bump each household's favorite brand
    brand_weights = base / base.sum(axis=1, keepdims=True)

    return Population(
        carrier_ids=carrier_ids,
        multipliers=multipliers,
        preferred_stores=preferred_stores,
        brand_weights=brand_weights,
        store_names=store_names,
        store_tax_ids=store_tax_ids,
        brands=brands,
    )
