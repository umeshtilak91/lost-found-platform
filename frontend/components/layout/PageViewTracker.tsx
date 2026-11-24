"use client";

import { usePathname } from "next/navigation";
import { useEffect, useRef } from "react";
import { useAuth } from "@/features/auth/AuthProvider";
import { api } from "@/lib/api";

// Sends one cookieless page-view per client-side navigation. Waits for the
// session check so the CSRF token is available. The API ignores bots and
// browsers sending Do-Not-Track / Global Privacy Control.
export function PageViewTracker() {
  const pathname = usePathname();
  const { loading } = useAuth();
  const first = useRef(true);
  const last = useRef<string | null>(null);

  useEffect(() => {
    if (loading || !pathname || last.current === pathname) return;
    last.current = pathname;
    const referrer = first.current ? document.referrer || undefined : undefined;
    first.current = false;
    api("/analytics/pageview", { method: "POST", json: { path: pathname, ...(referrer ? { referrer } : {}) } }).catch(() => {});
  }, [pathname, loading]);

  return null;
}
