-- verify.sql — post-run database consistency checks for the k6 load test.
-- Run after any profile to confirm the ingested data is sound: no orphans, no double
-- counting, totals that agree with their line items, and a clean per-day distribution.
--
-- Usage:
--   docker compose exec -T postgres psql -U invos -d invoices -f - < loadtest/verify.sql
--   (or)  psql "$DATABASE_URL" -f loadtest/verify.sql
--
-- Every check below prints PASS/FAIL so the output can be eyeballed or grepped in CI.

\echo '== row counts =='
SELECT
  (SELECT count(*) FROM invoices)      AS invoices,
  (SELECT count(*) FROM invoice_items) AS invoice_items;

-- 1. The natural key must be unique — the idempotent insert should make double counting
--    impossible. Any duplicate (invoice_number, invoice_date) pair is a correctness bug.
\echo '== 1. no duplicate natural keys =='
SELECT
  CASE WHEN count(*) = 0 THEN 'PASS' ELSE 'FAIL' END AS result,
  count(*) AS duplicate_keys
FROM (
  SELECT invoice_number, invoice_date
  FROM invoices
  GROUP BY invoice_number, invoice_date
  HAVING count(*) > 1
) d;

-- 2. Every item must belong to a real invoice (FK guarantees this, but we assert it so a
--    schema regression can't silently let orphans through).
\echo '== 2. no orphan items =='
SELECT
  CASE WHEN count(*) = 0 THEN 'PASS' ELSE 'FAIL' END AS result,
  count(*) AS orphan_items
FROM invoice_items it
LEFT JOIN invoices i ON i.id = it.invoice_id
WHERE i.id IS NULL;

-- 3. Every persisted invoice must have at least one item. A created invoice without items
--    would mean the two-statement insert was torn — it must never happen (same transaction).
\echo '== 3. every invoice has items =='
SELECT
  CASE WHEN count(*) = 0 THEN 'PASS' ELSE 'FAIL' END AS result,
  count(*) AS invoices_without_items
FROM invoices i
LEFT JOIN invoice_items it ON it.invoice_id = i.id
WHERE it.id IS NULL;

-- 4. Stored totals must equal the sum of their line items. The API rejects mismatches at
--    ingest (422), so zero rows here confirms no malformed payload slipped past the gate.
\echo '== 4. totals match line-item sums =='
SELECT
  CASE WHEN count(*) = 0 THEN 'PASS' ELSE 'FAIL' END AS result,
  count(*) AS inconsistent_invoices
FROM (
  SELECT i.id
  FROM invoices i
  JOIN invoice_items it ON it.invoice_id = i.id
  GROUP BY i.id, i.total_amount
  HAVING i.total_amount <> sum(it.amount)
) bad;

-- 5. Per-day distribution: invoice counts per day, so gaps or lopsided days are visible.
--    The Step-2 generator spreads invoices across a 90-day window; the load test only
--    replays that data, so the date span and shape must stay the same (no new dates, no day
--    inflated by double counting).
\echo '== 5. per-day distribution (first/last few days) =='
SELECT invoice_date, count(*) AS invoices, sum(total_amount) AS revenue
FROM invoices
GROUP BY invoice_date
ORDER BY invoice_date;
