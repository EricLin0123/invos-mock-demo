# cache.py — Parquet cache for generated invoice datasets.
# Generation is deterministic but not free (~18s for the default run), so we cache
# the result keyed by (config + seed). A cache hit reloads invoices from Parquet
# instead of regenerating; `--regenerate` overwrites the cache with fresh data.
#
# Each cache entry is two files in the cache dir:
#   <key>.parquet   — the invoices (nested list<struct> for line items)
#   <key>.gt.json   — the campaign ground truth (omitted when the campaign is off)
from __future__ import annotations

import hashlib
import json
import os

import pyarrow as pa
import pyarrow.parquet as pq


def cache_key(cfg: dict, seed: int) -> str:
    """Stable short key identifying a (config, seed) pair.

    Any change to the config or seed changes the key, so a stale cache is never
    silently reused. Canonical JSON (sorted keys) makes the hash order-independent.
    """
    canonical = json.dumps({"config": cfg, "seed": seed}, sort_keys=True)
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()[:16]


def cache_paths(cache_dir: str, key: str) -> tuple[str, str]:
    """Return (parquet_path, ground_truth_path) for a cache key."""
    return (
        os.path.join(cache_dir, f"{key}.parquet"),
        os.path.join(cache_dir, f"{key}.gt.json"),
    )


def is_cached(cache_dir: str, key: str) -> bool:
    """True if a Parquet cache entry exists for this key."""
    parquet_path, _ = cache_paths(cache_dir, key)
    return os.path.exists(parquet_path)


def save(cache_dir: str, key: str, invoices: list[dict], ground_truth: dict | None) -> str:
    """Write invoices (and optional ground truth) to the cache. Returns the parquet path."""
    os.makedirs(cache_dir, exist_ok=True)
    parquet_path, gt_path = cache_paths(cache_dir, key)

    # from_pylist infers a nested schema: top-level columns plus items as
    # list<struct<...>>, which round-trips back to identical Python dicts.
    table = pa.Table.from_pylist(invoices)
    # Stash the key in file metadata as a defensive cross-check against the filename.
    table = table.replace_schema_metadata({"cache_key": key})
    pq.write_table(table, parquet_path, compression="zstd")

    if ground_truth is not None:
        with open(gt_path, "w", encoding="utf-8") as f:
            json.dump(ground_truth, f, ensure_ascii=False, sort_keys=True)
    elif os.path.exists(gt_path):
        # Campaign was turned off for this key: drop a stale ground-truth sidecar.
        os.remove(gt_path)

    return parquet_path


def load(cache_dir: str, key: str) -> tuple[list[dict], dict | None]:
    """Load invoices and optional ground truth from the cache for this key."""
    parquet_path, gt_path = cache_paths(cache_dir, key)
    invoices = pq.read_table(parquet_path).to_pylist()

    ground_truth = None
    if os.path.exists(gt_path):
        with open(gt_path, "r", encoding="utf-8") as f:
            ground_truth = json.load(f)

    return invoices, ground_truth
