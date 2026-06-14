# test_generator.py — correctness tests for the simple data generator.
# Run with: cd generator && uv run pytest
import hashlib
import json
import re
from datetime import date

from conftest import small_config

from generator.invoices import generate
from generator.__main__ import write_ndjson, main

INVOICE_NUMBER_RE = re.compile(r"^[A-Z]{2}[0-9]{8}$")
RANDOM_CODE_RE = re.compile(r"^[0-9]{4}$")
TAX_ID_RE = re.compile(r"^[0-9]{8}$")

REQUIRED = {
    "invoice_number", "invoice_date", "random_code", "seller_tax_id",
    "seller_name", "carrier_id", "total_amount", "items",
}
ITEM_FIELDS = {"description", "category", "quantity", "unit_price", "amount"}


def _serialize(invoices):
    return "\n".join(
        json.dumps(inv, ensure_ascii=False, sort_keys=True) for inv in invoices
    )


def test_count_matches_config():
    cfg = small_config()
    invoices = generate(cfg, seed=42)
    assert len(invoices) == cfg["count"]


def test_determinism_same_seed_identical():
    cfg = small_config()
    assert _serialize(generate(cfg, seed=42)) == _serialize(generate(cfg, seed=42))


def test_different_seed_differs():
    cfg = small_config()
    assert _serialize(generate(cfg, seed=1)) != _serialize(generate(cfg, seed=2))


def test_file_hash_equal(tmp_path):
    cfg = small_config()
    p1, p2 = tmp_path / "a.ndjson", tmp_path / "b.ndjson"
    write_ndjson(generate(cfg, seed=7), str(p1))
    write_ndjson(generate(cfg, seed=7), str(p2))
    assert hashlib.sha256(p1.read_bytes()).hexdigest() == hashlib.sha256(p2.read_bytes()).hexdigest()


def test_totals_add_up():
    cfg = small_config()
    for inv in generate(cfg, seed=42):
        assert inv["items"], "every invoice has at least one item"
        for it in inv["items"]:
            assert it["amount"] == it["unit_price"] * it["quantity"]
        assert inv["total_amount"] == sum(it["amount"] for it in inv["items"])


def test_dated_today_not_spread():
    """Every invoice is dated today — no multi-month spread."""
    today = date.today().isoformat()
    assert {inv["invoice_date"] for inv in generate(small_config(), seed=42)} == {today}


def test_no_brand_field():
    """Items carry no brand."""
    for inv in generate(small_config(), seed=42):
        for it in inv["items"]:
            assert "brand" not in it


def test_schema_fields_present_and_valid():
    cfg = small_config()
    for inv in generate(cfg, seed=42):
        assert REQUIRED <= set(inv)
        assert INVOICE_NUMBER_RE.match(inv["invoice_number"])
        assert RANDOM_CODE_RE.match(inv["random_code"])
        assert TAX_ID_RE.match(inv["seller_tax_id"])
        assert inv["carrier_id"] is None or (
            inv["carrier_id"].startswith("/") and len(inv["carrier_id"]) == 8
        )
        assert 1 <= len(inv["items"]) <= 50
        for it in inv["items"]:
            assert ITEM_FIELDS <= set(it)


def test_cli_writes_file(tmp_path):
    out = tmp_path / "invoices.ndjson"
    assert main(["--out", str(out), "--seed", "42", "--count", "500"]) == 0
    lines = out.read_text().strip().splitlines()
    assert len(lines) == 500
    json.loads(lines[0])  # valid JSON
