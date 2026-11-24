import type { Locale } from "./i18n/messages";

const LOCALE_TAGS: Record<Locale, string> = { en: "en-IN", hi: "hi-IN" };

// Event dates are calendar dates (no time zone). Format them in UTC so the
// day never shifts for viewers in other time zones.
export function formatDate(date: string, locale: Locale) {
  return new Intl.DateTimeFormat(LOCALE_TAGS[locale], { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }).format(
    new Date(`${date}T00:00:00Z`)
  );
}

// Timestamps are shown in the viewer's time zone.
export function formatDateTime(iso: string, locale: Locale, timeZone?: string) {
  return new Intl.DateTimeFormat(LOCALE_TAGS[locale], {
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
    ...(timeZone ? { timeZone } : {}),
  }).format(new Date(iso));
}

export function formatRelative(iso: string, locale: Locale) {
  const diffSeconds = (new Date(iso).getTime() - Date.now()) / 1000;
  const rtf = new Intl.RelativeTimeFormat(LOCALE_TAGS[locale], { numeric: "auto" });
  const units: [Intl.RelativeTimeFormatUnit, number][] = [
    ["year", 31536000],
    ["month", 2592000],
    ["day", 86400],
    ["hour", 3600],
    ["minute", 60],
  ];
  for (const [unit, seconds] of units) {
    if (Math.abs(diffSeconds) >= seconds) return rtf.format(Math.round(diffSeconds / seconds), unit);
  }
  return rtf.format(0, "minute");
}

export function formatNumber(value: number, locale: Locale) {
  return new Intl.NumberFormat(LOCALE_TAGS[locale]).format(value);
}

export function todayIso() {
  const now = new Date();
  return new Date(now.getTime() - now.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}
