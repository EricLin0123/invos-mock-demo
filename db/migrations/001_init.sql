-- 001_init.sql — initial schema for mock Taiwanese e-invoice data.
-- Applied by server/scripts/migrate.js in filename order. Idempotent via IF NOT EXISTS.

-- Invoices: one row per issued e-invoice.
CREATE TABLE IF NOT EXISTS invoices (
    id             BIGSERIAL PRIMARY KEY,                 -- internal surrogate key
    invoice_number CHAR(10)    NOT NULL,                  -- 2 uppercase letters + 8 digits, e.g. AB12345678
    invoice_date   DATE        NOT NULL,                  -- date the invoice was issued
    random_code    CHAR(4)     NOT NULL,                  -- 4-digit verification code printed on the receipt
    seller_tax_id  CHAR(8)     NOT NULL,                  -- seller's 8-digit unified business number
    seller_name    TEXT        NOT NULL,                  -- seller display name
    carrier_id     TEXT,                                  -- mobile barcode carrier, e.g. /A1B2C3D (nullable: not every invoice uses one)
    total_amount   INTEGER     NOT NULL,                  -- invoice total in NTD (no cents)
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),    -- row insertion time

    -- Taiwanese invoice numbers are only unique within a bimonthly period, so the number
    -- alone is NOT a valid key. We pair it with the date to form a usable natural key.
    CONSTRAINT invoices_number_date_key UNIQUE (invoice_number, invoice_date)
);

-- Invoice line items: one row per product line on an invoice.
CREATE TABLE IF NOT EXISTS invoice_items (
    id          BIGSERIAL PRIMARY KEY,                                      -- internal surrogate key
    invoice_id  BIGINT  NOT NULL REFERENCES invoices(id) ON DELETE CASCADE, -- parent invoice; items removed with their invoice
    description TEXT    NOT NULL,                                           -- product description
    category    TEXT    NOT NULL,                                           -- product category, e.g. toothpaste, snacks
    brand       TEXT,                                                       -- product brand (nullable for unbranded goods)
    quantity    INTEGER NOT NULL,                                           -- units purchased
    unit_price  INTEGER NOT NULL,                                           -- price per unit in NTD (no cents)
    amount      INTEGER NOT NULL                                            -- line total in NTD = quantity * unit_price
);

-- Indexes supporting common query patterns (date-range reporting, category analysis, item lookups).
CREATE INDEX IF NOT EXISTS idx_invoices_invoice_date    ON invoices (invoice_date);
CREATE INDEX IF NOT EXISTS idx_invoice_items_category   ON invoice_items (category);
CREATE INDEX IF NOT EXISTS idx_invoice_items_invoice_id ON invoice_items (invoice_id);
