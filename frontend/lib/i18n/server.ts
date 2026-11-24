import "server-only";
import { cookies, headers } from "next/headers";
import { DEFAULT_LOCALE, isLocale, MESSAGES, translate, type Locale, type MessageKey } from "./messages";

export const LOCALE_COOKIE = "lf_locale";
export const TZ_COOKIE = "lf_tz";

// Locale: explicit cookie choice, then Accept-Language, then English.
export async function getLocale(): Promise<Locale> {
  const fromCookie = (await cookies()).get(LOCALE_COOKIE)?.value;
  if (isLocale(fromCookie)) return fromCookie;
  const accept = (await headers()).get("accept-language") || "";
  return /(^|,)\s*hi\b/i.test(accept) ? "hi" : DEFAULT_LOCALE;
}

export async function getTimeZone(): Promise<string | undefined> {
  const tz = (await cookies()).get(TZ_COOKIE)?.value;
  if (!tz) return undefined;
  try {
    new Intl.DateTimeFormat("en", { timeZone: tz });
    return tz;
  } catch {
    return undefined;
  }
}

export async function getT() {
  const locale = await getLocale();
  const messages = MESSAGES[locale];
  return { locale, t: (key: MessageKey, vars?: Record<string, string | number>) => translate(messages, key, vars) };
}
