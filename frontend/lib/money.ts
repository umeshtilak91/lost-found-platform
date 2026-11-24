// Formats integer paise as rupees, e.g. 50000 -> "₹500" (no decimals for whole rupees).
export function inr(paise: number | null | undefined, locale: "en" | "hi" = "en") {
  if (paise === null || paise === undefined) return "—";
  return new Intl.NumberFormat(locale === "hi" ? "hi-IN" : "en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: paise % 100 === 0 ? 0 : 2,
  }).format(paise / 100);
}

// Display-only fallback for the ₹100 connection fee while GET /api/pricing is
// loading or unreachable. The server (backend/src/config/pricing.js) is the
// only authority: it fixes the order amount and ignores any client amount.
export const FALLBACK_CONNECTION_FEE_PAISE = 10000;
