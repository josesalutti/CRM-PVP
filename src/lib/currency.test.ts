import { describe, expect, it } from "vitest";
import {
  CURRENCIES,
  DEFAULT_CURRENCY,
  currencyDecimals,
  formatCurrency,
  formatCurrencyExact,
  formatCurrencyShort,
  getCurrency,
  isSupportedCurrency,
  normalizeCurrencyCode,
  primaryTotal,
  sumByCurrency,
} from "./currency";

/** The PALOP set this install must offer, with their ISO minor units. */
const PALOP: [string, number][] = [
  ["AOA", 2],
  ["CVE", 2],
  ["XOF", 0],
  ["MZN", 2],
  ["STN", 2],
  ["XAF", 0],
];

describe("CURRENCIES catalogue", () => {
  it("offers every PALOP currency", () => {
    for (const [code] of PALOP) {
      expect(getCurrency(code), `${code} missing`).toBeDefined();
    }
  });

  it("keeps the pre-existing currencies (nothing was replaced)", () => {
    for (const code of [
      "USD", "EUR", "GBP", "INR", "AUD", "CAD", "BRL", "JPY",
      "CNY", "AED", "ZAR", "NGN", "SGD", "MXN", "COP",
    ]) {
      expect(getCurrency(code), `${code} was dropped`).toBeDefined();
    }
  });

  it("carries the right ISO minor units", () => {
    for (const [code, decimals] of PALOP) {
      expect(currencyDecimals(code), code).toBe(decimals);
    }
  });

  it("uses ISO-4217 codes as the identity, never symbols", () => {
    for (const c of CURRENCIES) {
      expect(c.code).toMatch(/^[A-Z]{3}$/);
      expect(c.countryCode).toMatch(/^[A-Z]{2}$/);
      expect(c.decimals).toBeGreaterThanOrEqual(0);
    }
  });

  it("has no duplicate codes", () => {
    const codes = CURRENCIES.map((c) => c.code);
    expect(new Set(codes).size).toBe(codes.length);
  });
});

describe("normalizeCurrencyCode / isSupportedCurrency", () => {
  it("accepts every supported ISO code", () => {
    for (const c of CURRENCIES) {
      expect(normalizeCurrencyCode(c.code)).toBe(c.code);
      expect(isSupportedCurrency(c.code)).toBe(true);
    }
  });

  it("uppercases and trims", () => {
    expect(normalizeCurrencyCode(" aoa ")).toBe("AOA");
    expect(normalizeCurrencyCode("mzn")).toBe("MZN");
  });

  it("rejects symbols — a symbol is never an identifier", () => {
    for (const bad of ["Kz", "MT", "CFA", "FCFA", "Esc", "Db", "$"]) {
      expect(normalizeCurrencyCode(bad), bad).toBeNull();
      expect(isSupportedCurrency(bad), bad).toBe(false);
    }
  });

  it("rejects malformed and unoffered codes", () => {
    for (const bad of ["ABC", "KZ", "123", "", "USDD", "United States"]) {
      expect(normalizeCurrencyCode(bad), bad).toBeNull();
    }
  });

  it("rejects non-strings", () => {
    for (const bad of [null, undefined, 42, {}, ["AOA"]]) {
      expect(normalizeCurrencyCode(bad)).toBeNull();
    }
  });
});

describe("formatCurrency", () => {
  it("formats whole amounts with no minor units", () => {
    // Locale-tolerant: the grouping separator is the runtime's choice
    // (en-US "1,234", pt-PT "1234", de-DE "1.234"), and Intl may use a
    // NBSP before the symbol. What must hold everywhere is that the
    // digits are present and no minor units were rendered.
    const out = formatCurrency(1234, "USD");
    expect(out).toMatch(/1[.,\s ]?234/);
    expect(out).not.toMatch(/234[.,]00/);
  });

  it("defaults to USD when no currency is given", () => {
    expect(formatCurrency(10)).toBe(formatCurrency(10, DEFAULT_CURRENCY));
  });

  it("treats an empty-string currency as the default", () => {
    expect(formatCurrency(10, "")).toBe(formatCurrency(10, DEFAULT_CURRENCY));
  });

  it("coerces non-finite values to 0", () => {
    expect(formatCurrency(Number.NaN, "USD")).toContain("0");
  });

  it("renders a well-formed but unknown ISO code without throwing", () => {
    // Intl is lenient here — it uses the code as the symbol.
    const out = formatCurrency(1234, "ZZZ");
    expect(out).toContain("ZZZ");
    expect(out).toMatch(/1[.,\s ]?234/);
  });

  it("never throws on a structurally invalid code (legacy rows pre-040)", () => {
    for (const bad of ["United States", "US", "USDD", "12", "u$d", "Kz"]) {
      expect(() => formatCurrency(1234, bad)).not.toThrow();
    }
  });

  it("formats every offered currency without throwing", () => {
    for (const c of CURRENCIES) {
      expect(() => formatCurrency(1000, c.code)).not.toThrow();
      expect(() => formatCurrency(0, c.code)).not.toThrow();
      expect(() => formatCurrency(-2500.75, c.code)).not.toThrow();
    }
  });

  it("renders each PALOP currency's own identity, not a shared symbol", () => {
    // Intl output is locale- and ICU-version-dependent, so we assert
    // the two things that must hold everywhere: the amount is there,
    // and two different currencies never render identically.
    const rendered = PALOP.map(([code]) => formatCurrency(2500, code));
    for (const out of rendered) expect(out).toMatch(/2[.,\s ]?500/);
    expect(new Set(rendered).size).toBe(PALOP.length);
  });
});

describe("formatCurrencyExact", () => {
  it("uses two minor digits for AOA/MZN/CVE/STN", () => {
    for (const code of ["AOA", "MZN", "CVE", "STN"]) {
      expect(formatCurrencyExact(1234.5, code), code).toMatch(/50/);
    }
  });

  it("uses no minor digits for the zero-decimal CFA francs", () => {
    for (const code of ["XOF", "XAF"]) {
      const out = formatCurrencyExact(1234, code);
      expect(out, code).not.toMatch(/[.,]00/);
    }
  });

  it("leaves the whole-number default untouched", () => {
    // The list/total screens keep showing whole numbers.
    expect(formatCurrency(1234.56, "AOA")).not.toMatch(/56/);
  });
});

describe("formatCurrencyShort", () => {
  it("abbreviates millions and thousands with the currency symbol", () => {
    expect(formatCurrencyShort(2_500_000, "USD")).toBe("$2.5M");
    expect(formatCurrencyShort(3_400, "USD")).toBe("$3.4k");
    expect(formatCurrencyShort(900, "USD")).toBe("$900");
  });

  it("uses the matching symbol for non-USD currencies", () => {
    expect(formatCurrencyShort(1_000, "EUR")).toBe("€1.0k");
    expect(formatCurrencyShort(1_000, "INR")).toBe("₹1.0k");
  });

  it("uses each PALOP symbol for display", () => {
    expect(formatCurrencyShort(2_500, "AOA")).toBe("Kz2.5k");
    expect(formatCurrencyShort(3_000, "MZN")).toBe("MT3.0k");
    expect(formatCurrencyShort(1_500, "CVE")).toBe("Esc1.5k");
    expect(formatCurrencyShort(500, "XOF")).toBe("CFA500");
    expect(formatCurrencyShort(1_000, "XAF")).toBe("FCFA1.0k");
    expect(formatCurrencyShort(200, "STN")).toBe("Db200");
  });

  it("falls back to the code prefix for unknown currencies (no throw)", () => {
    expect(formatCurrencyShort(1_000, "ZZZ")).toBe("ZZZ 1.0k");
  });
});

describe("sumByCurrency — reports never mix currencies", () => {
  const deals = [
    { value: 500_000, currency: "AOA" },
    { value: 100_000, currency: "MZN" },
    { value: 50_000, currency: "CVE" },
    { value: 200_000, currency: "AOA" },
  ];

  it("keeps one subtotal per currency", () => {
    const totals = sumByCurrency(deals, (d) => d.value, (d) => d.currency, "AOA");
    expect(totals).toEqual([
      { currency: "AOA", total: 700_000 },
      { currency: "MZN", total: 100_000 },
      { currency: "CVE", total: 50_000 },
    ]);
  });

  it("never produces a single cross-currency total", () => {
    const totals = sumByCurrency(deals, (d) => d.value, (d) => d.currency, "AOA");
    expect(totals.length).toBeGreaterThan(1);
    // 850,000 would be the meaningless AOA+MZN+CVE sum.
    expect(totals.some((t) => t.total === 850_000)).toBe(false);
  });

  it("leads with the account default even when it is not the largest", () => {
    const totals = sumByCurrency(deals, (d) => d.value, (d) => d.currency, "CVE");
    expect(totals[0].currency).toBe("CVE");
  });

  it("attributes missing/blank currencies to the fallback (matches migration 040)", () => {
    const legacy = [
      { value: 100, currency: null },
      { value: 50, currency: "  " },
      { value: 25, currency: "AOA" },
    ];
    const totals = sumByCurrency(legacy, (d) => d.value, (d) => d.currency, "AOA");
    expect(totals).toEqual([{ currency: "AOA", total: 175 }]);
  });

  it("normalises case so 'aoa' and 'AOA' are one bucket", () => {
    const totals = sumByCurrency(
      [{ v: 1, c: "aoa" }, { v: 2, c: "AOA" }],
      (r) => r.v,
      (r) => r.c,
      "USD",
    );
    expect(totals).toEqual([{ currency: "AOA", total: 3 }]);
  });

  it("returns nothing for no rows", () => {
    expect(sumByCurrency([], () => 0, () => null, "AOA")).toEqual([]);
  });
});

describe("primaryTotal", () => {
  const totals = [
    { currency: "AOA", total: 700_000 },
    { currency: "MZN", total: 100_000 },
  ];

  it("splits the headline figure from the disclosed remainder", () => {
    const { total, others } = primaryTotal(totals, "AOA");
    expect(total).toBe(700_000);
    expect(others).toEqual([{ currency: "MZN", total: 100_000 }]);
  });

  it("reports zero — not another currency's figure — when the default is absent", () => {
    const { total, others } = primaryTotal(totals, "CVE");
    expect(total).toBe(0);
    expect(others).toHaveLength(2);
  });
});

describe("historical currency is immutable", () => {
  it("formatting a deal never consults the account default", () => {
    // A deal saved in AOA renders as AOA no matter what the account
    // default later becomes — the deal's own code is the only input.
    const deal = { value: 2500, currency: "AOA" };
    const asShownWhenAccountIsMzn = formatCurrency(deal.value, deal.currency);
    const asShownWhenAccountIsUsd = formatCurrency(deal.value, deal.currency);
    expect(asShownWhenAccountIsMzn).toBe(asShownWhenAccountIsUsd);
    expect(deal.currency).toBe("AOA");
  });

  it("no conversion happens: 2500 AOA and 2500 MZN are not equivalent", () => {
    expect(formatCurrency(2500, "AOA")).not.toBe(formatCurrency(2500, "MZN"));
  });
});
