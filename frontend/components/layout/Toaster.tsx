"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { CheckCircle2, Info, X, XCircle } from "lucide-react";
import clsx from "clsx";

type Tone = "success" | "error" | "info";
type Toast = { id: number; message: string; tone: Tone };
const ToastContext = createContext<((message: string, tone?: Tone) => void) | null>(null);
const FLASH_KEY = "lf_flash";

// Short confirmations that slide in at the bottom and leave on their own.
// Announced politely to screen readers; errors use role="alert".
export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);
  const pathname = usePathname();

  const dismiss = useCallback((id: number) => setToasts((list) => list.filter((t) => t.id !== id)), []);
  const show = useCallback(
    (message: string, tone: Tone = "success") => {
      const id = nextId.current++;
      setToasts((list) => [...list.slice(-2), { id, message, tone }]);
      setTimeout(() => dismiss(id), tone === "error" ? 7000 : 4000);
    },
    [dismiss]
  );

  // Messages queued before a navigation (see flashToast) are shown on arrival.
  useEffect(() => {
    try {
      const raw = sessionStorage.getItem(FLASH_KEY);
      if (raw) {
        sessionStorage.removeItem(FLASH_KEY);
        const { message, tone } = JSON.parse(raw);
        setTimeout(() => show(message, tone), 50);
      }
    } catch {
      /* storage unavailable */
    }
  }, [pathname, show]);

  const icons = { success: CheckCircle2, error: XCircle, info: Info };
  return (
    <ToastContext.Provider value={show}>
      {children}
      <div aria-live="polite" className="pointer-events-none fixed inset-x-0 bottom-4 z-50 flex flex-col items-center gap-2 px-4">
        {toasts.map((toast) => {
          const Icon = icons[toast.tone];
          return (
            <div
              key={toast.id}
              role={toast.tone === "error" ? "alert" : "status"}
              className={clsx(
                "toast-in pointer-events-auto flex w-full max-w-md items-center gap-3 rounded-xl border bg-surface px-4 py-3 text-sm shadow-lg",
                toast.tone === "error" ? "border-lost/50" : toast.tone === "success" ? "border-found/50" : "border-border"
              )}
            >
              <Icon className={clsx("size-5 shrink-0", toast.tone === "error" ? "text-lost" : toast.tone === "success" ? "text-found" : "text-primary")} aria-hidden />
              <span className="flex-1">{toast.message}</span>
              <button type="button" onClick={() => dismiss(toast.id)} className="-m-2 rounded-lg p-2 text-muted hover:text-text" aria-label="Dismiss">
                <X className="size-4" aria-hidden />
              </button>
            </div>
          );
        })}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  const show = useContext(ToastContext);
  if (!show) throw new Error("useToast must be used inside ToastProvider");
  return show;
}

// Queue a toast to appear after the next page navigation.
export function flashToast(message: string, tone: Tone = "success") {
  try {
    sessionStorage.setItem(FLASH_KEY, JSON.stringify({ message, tone }));
  } catch {
    /* storage unavailable */
  }
}
