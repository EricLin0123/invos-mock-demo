# __main__.py — CLI entry point: `uv run python -m generator`.
# Reads config.yaml, generates invoices, writes them as NDJSON (one JSON object per line).

import argparse
import json
import os
import sys

import yaml

from .invoices import generate

_HERE = os.path.dirname(os.path.abspath(__file__))
_DEFAULT_CONFIG = os.path.join(_HERE, "..", "config.yaml")
_DEFAULT_OUT = os.path.join(_HERE, "..", "data", "invoices_90d.ndjson")


def _parse_args(argv):
    p = argparse.ArgumentParser(
        prog="generator",
        description="Generate simple mock Taiwanese e-invoice NDJSON.",
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
        "--count",
        type=int,
        default=None,
        help="number of invoices to generate (overrides config.count)",
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
    if args.count is not None:
        cfg["count"] = args.count

    invoices = generate(cfg, seed)
    write_ndjson(invoices, args.out)

    n_items = sum(len(inv["items"]) for inv in invoices)
    print(
        f"Wrote {len(invoices):,} invoices ({n_items:,} items) to {args.out} "
        f"[seed={seed}, count={len(invoices):,}]"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
