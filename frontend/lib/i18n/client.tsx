"use client";

import { createContext, useCallback, useContext, useEffect, useMemo } from "react";
import { useRouter } from "next/navigation";
import { MESSAGES, translate, type Locale, type MessageKey } from "./messages";

type I18nValue = {
  locale: Locale;
  t: (key: MessageKey, vars?: Record<string, string | number>) => string;
  setLocale: (locale: Locale) => void;
};

const I18nContext = createContext<I18nValue | null>(null);

export function I18nProvider({ locale, children }: { locale: Locale; children: React.ReactNode }) {
  const router = useRouter();

  // Remember the browser time zone so server-rendered timestamps match.
  useEffect(() => {
    try {
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
      if (tz && !document.cookie.includes(`lf_tz=${encodeURIComponent(tz)}`)) {
        document.cookie = `lf_tz=${encodeURIComponent(tz)}; path=/; max-age=31536000; samesite=lax`;
      }
    } catch {
      /* ignore */
    }
  }, []);

  const setLocale = useCallback(
    (next: Locale) => {
      document.cookie = `lf_locale=${next}; path=/; max-age=31536000; samesite=lax`;
      document.documentElement.lang = next;
      router.refresh();
    },
    [router]
  );

  const value = useMemo<I18nValue>(() => {
    const messages = MESSAGES[locale];
    return { locale, t: (key, vars) => translate(messages, key, vars), setLocale };
  }, [locale, setLocale]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n() {
  const value = useContext(I18nContext);
  if (!value) throw new Error("useI18n must be used inside I18nProvider");
  return value;
}
