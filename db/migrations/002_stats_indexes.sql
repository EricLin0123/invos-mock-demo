-- 002_stats_indexes.sql — indexes supporting the Step 3 read-back/aggregate endpoints.
-- Applied by server/scripts/migrate.js after 001_init.sql. Idempotent via IF NOT EXISTS.

-- /api/stats/daily groups and orders by invoice_date. 001 already indexes invoices(invoice_date),
-- so that aggregate is covered. The category-daily endpoint joins invoice_items to invoices and
-- filters/groups by category; a composite (category, invoice_id) index lets Postgres satisfy the
-- category filter and the join from the item side without a full scan.
CREATE INDEX IF NOT EXISTS idx_invoice_items_category_invoice
    ON invoice_items (category, invoice_id);
