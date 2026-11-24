// The web app's only environment settings, parsed in one place.
//
// The browser bundle reads no environment variables. There are no
// NEXT_PUBLIC_* values; the Razorpay key ID and Places settings come from the
// API at runtime (GET /api/payments/config, /api/places/config). Keep it that
// way: anything prefixed NEXT_PUBLIC_ is inlined into client JavaScript at
// build time and is readable by every visitor.
//
// This module is a plain function so next.config.ts (build time) and
// config/server.ts (request time, server only) share one parser.

export type WebEnv = {
  /** Where the Next.js server reaches the API (compose/cluster network). */
  apiInternalUrl: string;
  /** Public origin, used for absolute metadata URLs. */
  appUrl: string;
  isProduction: boolean;
};

function url(name: string, value: string | undefined, fallback: string): string {
  const raw = (value ?? "").trim() || fallback;
  try {
    const parsed = new URL(raw);
    if (!/^https?:$/.test(parsed.protocol)) throw new Error("protocol");
  } catch {
    // Name the variable, never echo its value.
    throw new Error(`${name} must be an absolute http(s) URL`);
  }
  return raw.replace(/\/$/, "");
}

export function readWebEnv(env: Record<string, string | undefined> = process.env): WebEnv {
  return {
    apiInternalUrl: url("API_INTERNAL_URL", env.API_INTERNAL_URL, "http://localhost:5000"),
    appUrl: url("APP_URL", env.APP_URL, "http://localhost:3000"),
    isProduction: env.NODE_ENV === "production",
  };
}
