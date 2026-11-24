"use client";

import { useSyncExternalStore } from "react";
import { Eye } from "lucide-react";
import { useI18n } from "@/lib/i18n/client";

const KEY = "lf_viewed";
const MAX = 300;

function read(): number[] {
  try {
    return JSON.parse(localStorage.getItem(KEY) || "[]");
  } catch {
    return [];
  }
}

// Remembers (in this browser only) which listings were opened.
export function markViewed(id: number) {
  try {
    const ids = [id, ...read().filter((x) => x !== id)].slice(0, MAX);
    localStorage.setItem(KEY, JSON.stringify(ids));
  } catch {
    /* storage unavailable */
  }
}

const subscribe = (callback: () => void) => {
  window.addEventListener("storage", callback);
  return () => window.removeEventListener("storage", callback);
};

export function ViewedBadge({ id }: { id: number }) {
  const { t } = useI18n();
  const viewed = useSyncExternalStore(
    subscribe,
    () => read().includes(id),
    () => false
  );
  if (!viewed) return null;
  return (
    <span className="absolute left-2 top-2 z-10 inline-flex items-center gap-1 rounded-full bg-black/65 px-2 py-0.5 text-xs font-medium text-white backdrop-blur">
      <Eye className="size-3.5" aria-hidden />
      {t("item.viewed")}
    </span>
  );
}
