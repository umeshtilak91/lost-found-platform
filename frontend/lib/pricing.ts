"use client";

import { useEffect, useState } from "react";
import type { Category } from "./types";

// Prices come from the API (single source of truth on the server); this
// module only fetches, caches and formats them.
export type Pricing = {
  currency: "INR";
  pricingVersion: string;
  termsVersion: string;
  connectionFeePaise: number;
  categories: { category: Category; rewardPaise: number }[];
};

let cached: Promise<Pricing> | null = null;
function loadPricing() {
  if (!cached) {
    cached = fetch("/api/pricing", { credentials: "same-origin" }).then((r) => {
      if (!r.ok) throw new Error("pricing");
      return r.json();
    });
    cached.catch(() => (cached = null));
  }
  return cached;
}

export function usePricing() {
  const [pricing, setPricing] = useState<Pricing | null>(null);
  useEffect(() => {
    let alive = true;
    loadPricing().then((p) => alive && setPricing(p), () => {});
    return () => {
      alive = false;
    };
  }, []);
  return pricing;
}

export function rewardOf(pricing: Pricing | null, category: string | undefined) {
  return pricing?.categories.find((c) => c.category === category)?.rewardPaise ?? null;
}
