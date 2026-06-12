# __main__.py — CLI entry point: `uv run python -m generator`.
# Loads config, runs the (deterministic) generator, and writes NDJSON +
# ground_truth.json. The only module in this package that touches the filesystem.
from __future__ import annotations

import argparse
import json
import os
import sys

import yaml

from . import cache
from .invoices import generate

_REPO = os.path.dirname(os.path.dirname(__file__))
_DEFAULT_CONFIG = os.path.join(_REPO, "config.yaml")
_DEFAULT_OUT = os.path.join(_REPO, "data", "invoices.ndjson")
_DEFAULT_CACHE_DIR = os.path.join(_REPO, "data", "cache")


def _parse_args(argv):
    p = argparse.ArgumentParser(
        prog="generator",
        description="Generate deterministic mock Taiwanese e-invoice NDJSON.",
    )
    p.add_argument("--config", default=_DEFAULT_CONFIG, help="path to config.yaml")
    p.add_argument("--out", default=_DEFAULT_OUT, help="output NDJSON file path")
    p.add_argument(
        "--seed",
        type=int,
        default=None,
        help="RNG seed (overrides config.seed); same seed+config => identical output",
    )
    p.add_argument(
        "--cache-dir",
        default=_DEFAULT_CACHE_DIR,
        help="directory holding the Parquet cache (keyed by config+seed)",
    )
    p.add_argument(
        "--regenerate",
        action="store_true",
        help="force regeneration, overwriting any cached data (default: use cache)",
    )
    p.add_argument(
        "--no-cache",
        action="store_true",
        help="neither read nor write the cache (always regenerate, in-memory only)",
    )
    return p.parse_args(argv)


def write_ndjson(invoices, path: str) -> None:
    """Write one JSON object per line, with stable key ordering for reproducibility."""
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        for inv in invoices:
            f.write(json.dumps(inv, ensure_ascii=False, sort_keys=True))
            f.write("\n")


def main(argv=None) -> int:
    args = _parse_args(argv if argv is not None else sys.argv[1:])

    with open(args.config, "r", encoding="utf-8") as f:
        cfg = yaml.safe_load(f)

    seed = args.seed if args.seed is not None else int(cfg.get("seed", 0))

    # Resolve data either from the Parquet cache (default) or by regenerating.
    key = cache.cache_key(cfg, seed)
    if not args.no_cache and not args.regenerate and cache.is_cached(args.cache_dir, key):
        invoices, ground_truth = cache.load(args.cache_dir, key)
        source = f"cache ({key})"
    else:
        invoices, ground_truth = generate(cfg, seed)
        if not args.no_cache:
            cache.save(args.cache_dir, key, invoices, ground_truth)
            source = f"regenerated -> cache ({key})" if args.regenerate else f"generated -> cache ({key})"
        else:
            source = "generated (cache bypassed)"

    write_ndjson(invoices, args.out)

    # Ground truth lands next to the NDJSON output whenever the campaign is on.
    if ground_truth is not None:
        gt_path = os.path.join(os.path.dirname(os.path.abspath(args.out)), "ground_truth.json")
        with open(gt_path, "w", encoding="utf-8") as f:
            json.dump(ground_truth, f, ensure_ascii=False, indent=2, sort_keys=True)

    n_items = sum(len(inv["items"]) for inv in invoices)
    print(
        f"Wrote {len(invoices):,} invoices ({n_items:,} items) to {args.out} "
        f"[source={source}, seed={seed}, days={cfg['simulation']['days']}, "
        f"households={cfg['population']['households']}]"
    )
    if ground_truth is not None:
        print(
            f"Campaign enabled: {ground_truth['n_exposed']:,} exposed households, "
            f"ground truth -> {os.path.join(os.path.dirname(args.out), 'ground_truth.json')}"
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
