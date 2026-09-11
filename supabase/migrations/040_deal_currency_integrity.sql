-- ============================================================
-- 040_deal_currency_integrity
-- ============================================================
-- Make every deal carry an explicit ISO-4217 currency.
--
-- Before this migration `deals.currency` was `TEXT DEFAULT 'USD'`
-- (migration 001) with no NOT NULL and no CHECK, while
-- `accounts.default_currency` (migration 021) had both. That gap let
-- three kinds of row exist:
--
--   1. currency IS NULL  — inserted by a client that omitted the
--      column before the default applied, or by the public API.
--   2. currency = ''     — empty string from a form or CSV import.
--   3. malformed values  — "United States", "kz", "Kz": the symbol
--      used as an identifier, which ISO 4217 forbids and which
--      `Intl.NumberFormat` throws a RangeError on.
--
-- Reading code already defends against all three (src/lib/currency.ts
-- falls back rather than crashing), but the data should be right at
-- the source.
--
-- SAFETY — this migration:
--   * NEVER changes a deal's `value`. No amount is touched, rounded
--     or converted. There is no FX conversion anywhere in this app.
--   * NEVER deletes a row.
--   * only writes `currency` on rows that have no usable currency,
--     and writes the deal's OWN account default — not a global
--     constant — so an account already on AOA backfills to AOA.
--   * is idempotent: re-running it matches nothing and re-creates the
--     constraint from scratch.
--
-- The historical currency of a deal is immutable business data: once
-- a deal is saved in AOA it stays AOA, no matter what the account
-- default is later changed to. Nothing here or in the app rewrites it.
-- ============================================================

-- Single transaction: either every step lands, or none does. A
-- failure in step 4 (e.g. a missing prerequisite migration) rolls the
-- backfill back instead of leaving a half-migrated table.
BEGIN;

-- 1. Backfill NULL / blank / malformed codes from the owning account.
--    `accounts.default_currency` is NOT NULL with a '^[A-Z]{3}$'
--    CHECK since migration 021, so the source value is always valid.
UPDATE deals d
SET currency = a.default_currency
FROM accounts a
WHERE d.account_id = a.id
  AND (
    d.currency IS NULL
    OR btrim(d.currency) = ''
    OR btrim(upper(d.currency)) !~ '^[A-Z]{3}$'
  );

-- 2. Any deal whose account row is missing (should be impossible —
--    account_id is NOT NULL REFERENCES accounts since migration 017)
--    falls back to the app-wide default, matching DEFAULT_CURRENCY
--    in src/lib/currency.ts. Belt and braces so step 4 cannot fail.
UPDATE deals
SET currency = 'USD'
WHERE currency IS NULL
   OR btrim(currency) = ''
   OR btrim(upper(currency)) !~ '^[A-Z]{3}$';

-- 3. Canonicalise casing/whitespace on the rows that were already
--    well-formed ("usd" -> "USD"). ISO codes are uppercase.
UPDATE deals
SET currency = btrim(upper(currency))
WHERE currency IS DISTINCT FROM btrim(upper(currency));

-- 4. Lock the shape in. Format-only, mirroring migration 021 rather
--    than pinning to a fixed enum — forks can use any currency Intl
--    supports by adding it to CURRENCIES in src/lib/currency.ts.
ALTER TABLE deals
  ALTER COLUMN currency SET DEFAULT 'USD';

ALTER TABLE deals
  ALTER COLUMN currency SET NOT NULL;

ALTER TABLE deals
  DROP CONSTRAINT IF EXISTS deals_currency_format;

ALTER TABLE deals
  ADD CONSTRAINT deals_currency_format
  CHECK (currency ~ '^[A-Z]{3}$');

COMMENT ON COLUMN deals.currency IS
  'ISO-4217 code this deal''s value is denominated in. Immutable business data: set when the deal is created from the account default, and never rewritten when that default changes. No FX conversion is performed anywhere.';

COMMIT;
