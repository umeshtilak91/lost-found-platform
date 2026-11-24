"use client";

import { createContext, useCallback, useContext, useState } from "react";
import { Moon, Sun } from "lucide-react";
import { useI18n } from "@/lib/i18n/client";

export type Theme = "dark" | "light";
const ThemeContext = createContext<{ theme: Theme; toggle: () => void } | null>(null);

// The server renders <html data-theme> from the lf_theme cookie (default
// dark), so there is no flash; toggling updates the attribute and cookie.
export function ThemeProvider({ initial, children }: { initial: Theme; children: React.ReactNode }) {
  const [theme, setTheme] = useState<Theme>(initial);
  const toggle = useCallback(() => {
    setTheme((current) => {
      const next: Theme = current === "dark" ? "light" : "dark";
      document.documentElement.dataset.theme = next;
      document.cookie = `lf_theme=${next}; path=/; max-age=31536000; samesite=lax`;
      return next;
    });
  }, []);
  return <ThemeContext.Provider value={{ theme, toggle }}>{children}</ThemeContext.Provider>;
}

export function ThemeToggle({ withLabel = false }: { withLabel?: boolean }) {
  const ctx = useContext(ThemeContext);
  const { t } = useI18n();
  if (!ctx) return null;
  const label = ctx.theme === "dark" ? t("nav.themeLight") : t("nav.themeDark");
  const Icon = ctx.theme === "dark" ? Sun : Moon;
  return (
    <button
      type="button"
      onClick={ctx.toggle}
      aria-label={withLabel ? undefined : label}
      title={label}
      className={
        withLabel
          ? "flex min-h-11 w-full items-center gap-2 rounded-lg px-2 text-left font-medium hover:bg-surface-muted"
          : "inline-flex size-11 items-center justify-center rounded-lg hover:bg-surface-muted"
      }
    >
      <Icon className="size-5" aria-hidden />
      {withLabel && <span>{label}</span>}
    </button>
  );
}
