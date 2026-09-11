/**
 * Currency — single source of truth for deal-value formatting, the
 * currency picker options, and ISO-4217 validation.
 *
 * Before this module, ~6 components each defined their own
 * `Intl.NumberFormat(..., { currency: "USD" })` helper with USD
 * baked in. The default currency is now configurable per account
 * (accounts.default_currency, migration 021), so every formatter
 * takes a currency and falls back to DEFAULT_CURRENCY only when
 * nothing is known.
 *
 * ISO 4217 is the identity of a currency everywhere in the app: the
 * three-letter code is what we store, compare and validate. A symbol
 * ("Kz", "MT", "$") is presentation only and MUST NOT be used as an
 * identifier — several are ambiguous across currencies ($ is USD,
 * MXN and COP; ¥ is JPY and CNY; CFA is XOF while FCFA is XAF).
 */

/**
 * App-wide fallback when no account/deal currency is available.
 *
 * This is USD, not because USD is special, but because it is what
 * migrations 001 and 021 wrote as the column default: every existing
 * account and deal that never picked a currency is USD today.
 * Changing this constant would silently restate historical deal
 * values in another currency, so it stays put. Per-account defaults
 * are set in Settings -> Deals & currency.
 */
export const DEFAULT_CURRENCY = "USD";

export interface CurrencyOption {
  /** ISO-4217 alphabetic code, e.g. "AOA". Stored verbatim in the DB. */
  code: string;
  /** Human label for the dropdown, e.g. "Kwanza". */
  label: string;
  /** Symbol for compact display, e.g. "Kz". Presentation only. */
  symbol: string;
  /**
   * ISO-3166-1 alpha-2 code of the currency's primary country, e.g.
   * "AO". Informational — used for flags and country-aware pickers.
   * Shared currencies list the country most relevant to this app
   * (XOF -> GW, XAF -> GQ), not their whole monetary union.
   */
  countryCode: string;
  /**
   * ISO-4217 minor units: 2 for AOA/MZN, 0 for the CFA francs and JPY.
   * Deal values display as whole numbers by default (see
   * {@link formatCurrency}); this drives {@link formatCurrencyExact}
   * and any caller that needs true ISO precision.
   */
  decimals: number;
}

/**
 * The currencies offered in pickers. Codes must be valid ISO-4217 so
 * `Intl.NumberFormat` renders the right symbol and grouping.
 *
 * TO ADD A CURRENCY: append one entry here. Nothing else needs to
 * change — the pickers, the validator, the formatters and the
 * per-currency report totals all read this list.
 */
export const CURRENCIES: CurrencyOption[] = [
  // — PALOP / lusophone Africa —————————————————————————
  { code: "AOA", label: "Kwanza", symbol: "Kz", countryCode: "AO", decimals: 2 },
  { code: "CVE", label: "Cape Verdean Escudo", symbol: "Esc", countryCode: "CV", decimals: 2 },
  { code: "XOF", label: "CFA Franc BCEAO", symbol: "CFA", countryCode: "GW", decimals: 0 },
  { code: "MZN", label: "Mozambican Metical", symbol: "MT", countryCode: "MZ", decimals: 2 },
  { code: "STN", label: "Dobra", symbol: "Db", countryCode: "ST", decimals: 2 },
  { code: "XAF", label: "CFA Franc BEAC", symbol: "FCFA", countryCode: "GQ", decimals: 0 },
  // — pre-existing currencies (unchanged) ————————————————
  { code: "USD", label: "US Dollar", symbol: "$", countryCode: "US", decimals: 2 },
  { code: "EUR", label: "Euro", symbol: "€", countryCode: "EU", decimals: 2 },
  { code: "GBP", label: "British Pound", symbol: "£", countryCode: "GB", decimals: 2 },
  { code: "INR", label: "Indian Rupee", symbol: "₹", countryCode: "IN", decimals: 2 },
  { code: "AUD", label: "Australian Dollar", symbol: "A$", countryCode: "AU", decimals: 2 },
  { code: "CAD", label: "Canadian Dollar", symbol: "C$", countryCode: "CA", decimals: 2 },
  { code: "BRL", label: "Brazilian Real", symbol: "R$", countryCode: "BR", decimals: 2 },
  { code: "JPY", label: "Japanese Yen", symbol: "¥", countryCode: "JP", decimals: 0 },
  { code: "CNY", label: "Chinese Yuan", symbol: "¥", countryCode: "CN", decimals: 2 },
  { code: "AED", label: "UAE Dirham", symbol: "د.إ", countryCode: "AE", decimals: 2 },
  { code: "ZAR", label: "South African Rand", symbol: "R", countryCode: "ZA", decimals: 2 },
  { code: "NGN", label: "Nigerian Naira", symbol: "₦", countryCode: "NG", decimals: 2 },
  { code: "SGD", label: "Singapore Dollar", symbol: "S$", countryCode: "SG", decimals: 2 },
  { code: "MXN", label: "Mexican Peso", symbol: "$", countryCode: "MX", decimals: 2 },
  { code: "COP", label: "Colombian Peso", symbol: "$", countryCode: "CO", decimals: 2 },
];

/** Index for O(1) lookups. Built once; CURRENCIES is module-constant. */
const BY_CODE = new Map(CURRENCIES.map((c) => [c.code, c]));

/**
 * Normalise a user/API-supplied currency code to the canonical
 * uppercase ISO form. Returns null when the input is not a supported
 * code — including symbols ("Kz", "MT", "CFA"), which are never
 * identifiers. Whitespace and lowercase are tolerated because API
 * clients and CSV imports produce both.
 */
export function normalizeCurrencyCode(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const code = input.trim().toUpperCase();
  return BY_CODE.has(code) ? code : null;
}

/** True when `input` is a currency this install offers. */
export function isSupportedCurrency(input: unknown): boolean {
  return normalizeCurrencyCode(input) !== null;
}

/**
 * Look up a currency's metadata. Returns undefined for codes not in
 * CURRENCIES — including well-formed ISO codes we simply do not
 * offer, which legacy rows may still carry.
 */
export function getCurrency(code: string): CurrencyOption | undefined {
  return BY_CODE.get((code ?? "").trim().toUpperCase());
}

/** The ISO minor-unit count for a code; 2 when the code is unknown. */
export function currencyDecimals(code: string): number {
  return getCurrency(code)?.decimals ?? 2;
}

/**
 * Format a deal value as a currency string. Whole-number output
 * (no minor units) by default — deal values are tracked to the unit
 * across the app, and that is what every existing screen shows.
 * Pass `{ decimals }`, or use {@link formatCurrencyExact}, when true
 * ISO precision is wanted.
 *
 * `currency` defaults to USD so callers with nothing better stay
 * safe, but pass the account/deal currency wherever known.
 *
 * Total by design: `Intl.NumberFormat` throws a RangeError on a
 * structurally invalid currency code, and `deals.currency` carried
 * NO DB CHECK before migration 040, so legacy rows, imports, or
 * hand-edited data can hold malformed values like "United States".
 * We never let that crash a render — on a bad code we fall back to
 * "CODE 1,234".
 */
export function formatCurrency(
  value: number,
  currency: string = DEFAULT_CURRENCY,
  options: { decimals?: number } = {},
): string {
  const code = (currency || DEFAULT_CURRENCY).trim();
  const amount = Number(value) || 0;
  const digits = options.decimals ?? 0;
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: code,
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    }).format(amount);
  } catch {
    // Invalid ISO code — show the raw code + grouped number so the
    // value is still legible instead of throwing.
    return `${code} ${new Intl.NumberFormat(undefined, {
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    }).format(amount)}`;
  }
}

/**
 * Format at the currency's own ISO-4217 precision: 1234.5 AOA renders
 * with two minor digits, 1234.5 XOF with none (zero-decimal
 * currency). Use where minor units matter; the app's list and total
 * screens deliberately use the whole-number {@link formatCurrency}.
 */
export function formatCurrencyExact(
  value: number,
  currency: string = DEFAULT_CURRENCY,
): string {
  return formatCurrency(value, currency, {
    decimals: currencyDecimals(currency || DEFAULT_CURRENCY),
  });
}

/**
 * Compact currency for tight spaces (donut center, legend rows):
 * "$1.2M" / "€34.5k" / "Kz900". Uses the currency's symbol from
 * CURRENCIES, falling back to the code when we do not carry a symbol.
 */
export function formatCurrencyShort(
  value: number,
  currency: string = DEFAULT_CURRENCY,
): string {
  const code = currency || DEFAULT_CURRENCY;
  const symbol = getCurrency(code)?.symbol ?? `${code} `;
  return `${symbol}${formatCompactNumber(value)}`;
}

/**
 * Compact number for tight spaces (chart tiles, legends): 1_234 -> "1.2k",
 * 1_200_000 -> "1.2M", 900 -> "900". The unit-less core shared with
 * {@link formatCurrencyShort}.
 */
export function formatCompactNumber(value: number): string {
  const v = Number(value || 0);
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `${(v / 1_000).toFixed(1)}k`;
  return v.toFixed(0);
}

/** A per-currency subtotal. Entries are never summed together. */
export interface CurrencyTotal {
  /** ISO-4217 code as stored on the rows. */
  currency: string;
  /** Sum of the rows carrying exactly that currency. */
  total: number;
}

/**
 * Group monetary rows into one subtotal per currency.
 *
 * This app performs NO FX conversion, so adding 500,000 AOA to
 * 100,000 MZN is not a number that means anything. Every total the
 * UI shows must come from here, keeping the currencies apart. Rows
 * with a missing or blank currency are attributed to `fallback` (the
 * account default), matching what migration 040 backfilled.
 *
 * Returns the fallback currency first when present, then the rest by
 * descending total, so the headline figure is stable across renders.
 */
export function sumByCurrency<T>(
  rows: readonly T[],
  getValue: (row: T) => number | null | undefined,
  getCurrencyCode: (row: T) => string | null | undefined,
  fallback: string = DEFAULT_CURRENCY,
): CurrencyTotal[] {
  const totals = new Map<string, number>();
  for (const row of rows) {
    const raw = (getCurrencyCode(row) ?? "").trim().toUpperCase();
    const code = raw || fallback.toUpperCase();
    totals.set(code, (totals.get(code) ?? 0) + (Number(getValue(row)) || 0));
  }
  const primary = fallback.toUpperCase();
  return [...totals.entries()]
    .map(([currency, total]) => ({ currency, total }))
    .sort((a, b) => {
      if (a.currency === primary) return -1;
      if (b.currency === primary) return 1;
      return b.total - a.total;
    });
}

/**
 * Pick the subtotal for `currency` out of a {@link sumByCurrency}
 * result, and report whether other currencies are also present — the
 * signal a screen needs in order to disclose "+ 2 other currencies"
 * instead of quietly showing a partial figure as if it were the whole.
 */
export function primaryTotal(
  totals: readonly CurrencyTotal[],
  currency: string = DEFAULT_CURRENCY,
): { total: number; others: CurrencyTotal[] } {
  const code = (currency || DEFAULT_CURRENCY).trim().toUpperCase();
  return {
    total: totals.find((t) => t.currency === code)?.total ?? 0,
    others: totals.filter((t) => t.currency !== code),
  };
}
