# test_generator.py — correctness + statistical tests for the data generator.
# Run with: cd generator && uv run pytest
import json
import math
import re

from conftest import small_config

from generator import cache
from generator.invoices import generate
from generator.__main__ import write_ndjson, main

INVOICE_NUMBER_RE = re.compile(r"^[A-Z]{2}[0-9]{8}$")


def _serialize(invoices):
    """Mirror the on-disk NDJSON serialization so determinism is tested byte-for-byte."""
    return "\n".join(
        json.dumps(inv, ensure_ascii=False, sort_keys=True) for inv in invoices
    )


def test_determinism_same_seed_identical():
    cfg = small_config()
    a, gt_a = generate(cfg, seed=42)
    b, gt_b = generate(cfg, seed=42)
    assert _serialize(a) == _serialize(b)
    assert gt_a == gt_b


def test_different_seed_differs():
    cfg = small_config()
    a, _ = generate(cfg, seed=1)
    b, _ = generate(cfg, seed=2)
    assert _serialize(a) != _serialize(b)


def test_file_hash_equal(tmp_path):
    """Re-running with the same seed produces a hash-equal NDJSON file."""
    import hashlib

    cfg = small_config()
    inv, _ = generate(cfg, seed=7)
    p1 = tmp_path / "a.ndjson"
    p2 = tmp_path / "b.ndjson"
    write_ndjson(inv, str(p1))
    inv2, _ = generate(cfg, seed=7)
    write_ndjson(inv2, str(p2))
    h1 = hashlib.sha256(p1.read_bytes()).hexdigest()
    h2 = hashlib.sha256(p2.read_bytes()).hexdigest()
    assert h1 == h2


def test_invoice_number_format():
    cfg = small_config()
    invoices, _ = generate(cfg, seed=42)
    assert invoices, "expected some invoices"
    for inv in invoices:
        assert INVOICE_NUMBER_RE.match(inv["invoice_number"]), inv["invoice_number"]


def test_totals_add_up():
    cfg = small_config()
    invoices, _ = generate(cfg, seed=42)
    for inv in invoices:
        assert inv["items"], "every invoice has at least one item"
        for it in inv["items"]:
            assert it["amount"] == it["unit_price"] * it["quantity"]
        assert inv["total_amount"] == sum(it["amount"] for it in inv["items"])


def test_chronological_order():
    cfg = small_config()
    invoices, _ = generate(cfg, seed=42)
    dates = [inv["invoice_date"] for inv in invoices]
    assert dates == sorted(dates)


def test_schema_fields_present():
    cfg = small_config()
    invoices, _ = generate(cfg, seed=42)
    required = {
        "invoice_number", "invoice_date", "random_code", "seller_tax_id",
        "seller_name", "carrier_id", "total_amount", "items",
    }
    item_fields = {"description", "category", "brand", "quantity", "unit_price", "amount"}
    for inv in invoices[:100]:
        assert required <= set(inv)
        assert len(inv["seller_tax_id"]) == 8 and inv["seller_tax_id"].isdigit()
        assert len(inv["random_code"]) == 4 and inv["random_code"].isdigit()
        assert inv["carrier_id"].startswith("/") and len(inv["carrier_id"]) == 8
        for it in inv["items"]:
            assert item_fields <= set(it)


def test_cache_roundtrip_identical(tmp_path):
    """Loading invoices from the Parquet cache reproduces byte-identical NDJSON."""
    cfg = small_config()
    invoices, gt = generate(cfg, seed=42)
    key = cache.cache_key(cfg, 42)
    cache.save(str(tmp_path), key, invoices, gt)

    loaded, gt_loaded = cache.load(str(tmp_path), key)
    assert _serialize(loaded) == _serialize(invoices)
    assert gt_loaded == gt


def test_cache_key_sensitive_to_seed_and_config():
    cfg = small_config()
    other = small_config()
    other["simulation"]["days"] += 1
    assert cache.cache_key(cfg, 1) != cache.cache_key(cfg, 2)
    assert cache.cache_key(cfg, 1) != cache.cache_key(other, 1)


def test_cli_uses_cache_by_default(tmp_path, monkeypatch):
    """Second CLI run hits the cache (no regeneration) and yields the same file."""
    # Point the generator at a tiny config so the CLI run is fast.
    import yaml

    cfg = small_config()
    cfg_path = tmp_path / "config.yaml"
    cfg_path.write_text(yaml.safe_dump(cfg))
    cache_dir = tmp_path / "cache"
    out = tmp_path / "invoices.ndjson"

    base_args = [
        "--config", str(cfg_path),
        "--out", str(out),
        "--seed", "42",
        "--cache-dir", str(cache_dir),
    ]

    # First run: generates + populates the cache.
    assert main(base_args) == 0
    first = out.read_bytes()
    key = cache.cache_key(cfg, 42)
    assert cache.is_cached(str(cache_dir), key)

    # Generation must NOT be called on the second run (cache hit).
    import generator.__main__ as m

    def _boom(*a, **k):
        raise AssertionError("generate() called despite a warm cache")

    monkeypatch.setattr(m, "generate", _boom)
    assert main(base_args) == 0
    assert out.read_bytes() == first

    # With --regenerate, generation runs again (restore the real function first).
    monkeypatch.undo()
    assert main(base_args + ["--regenerate"]) == 0
    assert out.read_bytes() == first  # deterministic => identical bytes


def _two_proportion_z(success_a, n_a, success_b, n_b):
    """Two-proportion z-test; returns (z, two-sided p-value via normal approximation)."""
    p_a = success_a / n_a
    p_b = success_b / n_b
    p_pool = (success_a + success_b) / (n_a + n_b)
    se = math.sqrt(p_pool * (1 - p_pool) * (1 / n_a + 1 / n_b))
    z = (p_a - p_b) / se
    # Two-sided p via the complementary error function.
    p_value = math.erfc(abs(z) / math.sqrt(2))
    return z, p_value


def test_campaign_raises_toothpaste_rate():
    """Exposed households must have a significantly higher post-campaign toothpaste rate."""
    cfg = small_config()
    invoices, gt = generate(cfg, seed=42)
    assert gt is not None and gt["enabled"]

    exposed = set(gt["exposed_carrier_ids"])
    start_date = gt["start_date"]

    # Count, among invoices on/after the campaign start, how many contain toothpaste,
    # split by whether the buyer was exposed.
    succ_exp = n_exp = succ_un = n_un = 0
    for inv in invoices:
        if inv["invoice_date"] < start_date:
            continue
        has_tp = any(it["category"] == "toothpaste" for it in inv["items"])
        if inv["carrier_id"] in exposed:
            n_exp += 1
            succ_exp += int(has_tp)
        else:
            n_un += 1
            succ_un += int(has_tp)

    z, p = _two_proportion_z(succ_exp, n_exp, succ_un, n_un)
    rate_exp = succ_exp / n_exp
    rate_un = succ_un / n_un
    assert rate_exp > rate_un, (rate_exp, rate_un)
    assert p < 0.01, f"campaign effect not significant: z={z:.2f} p={p:.4g}"
