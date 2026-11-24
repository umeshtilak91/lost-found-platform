"use client";

// Accessible confirmation dialog (role="alertdialog"): focus moves into the
// dialog, Tab stays inside, Escape cancels, and focus returns to the opener.

import { useEffect, useId, useRef } from "react";

export function ConfirmDialog({
  open,
  title,
  children,
  onCancel,
  actions,
  busy,
}: {
  open: boolean;
  title: string;
  children?: React.ReactNode;
  onCancel: () => void;
  actions: React.ReactNode;
  busy?: boolean;
}) {
  const titleId = useId();
  const bodyId = useId();
  const ref = useRef<HTMLDivElement>(null);
  const opener = useRef<Element | null>(null);

  useEffect(() => {
    if (!open) return;
    opener.current = document.activeElement;
    const node = ref.current;
    const focusables = () => Array.from(node?.querySelectorAll<HTMLElement>("button:not([disabled]), textarea, input, a[href]") ?? []);
    focusables()[0]?.focus();
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape" && !busy) {
        event.preventDefault();
        onCancel();
      } else if (event.key === "Tab") {
        const list = focusables();
        if (!list.length) return;
        const first = list[0];
        const last = list[list.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    }
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      (opener.current as HTMLElement | null)?.focus?.();
    };
  }, [open, busy, onCancel]);

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 p-4 sm:items-center" onMouseDown={(e) => e.target === e.currentTarget && !busy && onCancel()}>
      <div
        ref={ref}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={children ? bodyId : undefined}
        aria-busy={busy || undefined}
        className="menu-in w-full max-w-md rounded-xl border border-border bg-surface p-5 shadow-xl"
      >
        <h2 id={titleId} className="text-lg font-semibold">
          {title}
        </h2>
        {children && (
          <div id={bodyId} className="mt-2 text-sm text-muted">
            {children}
          </div>
        )}
        <div className="mt-5 flex flex-col gap-2 sm:flex-row-reverse sm:flex-wrap">{actions}</div>
      </div>
    </div>
  );
}
