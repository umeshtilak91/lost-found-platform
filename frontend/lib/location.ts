// One client-side definition of a location, shared by the homepage search,
// the browse filters and the report/edit form.

export type LocationSource = "provider" | "device" | "manual" | "legacy";

export type LocationValue = {
  label: string;
  source: LocationSource;
  placeId?: string;
  lat?: number;
  lng?: number;
  country?: string;
  accuracyM?: number;
};

export type Suggestion = { placeId: string; primary: string; secondary: string; label: string };

export const EMPTY_LOCATION: LocationValue = { label: "", source: "manual" };
export const RADIUS_OPTIONS = ["2", "5", "10", "25"] as const;
export const DEFAULT_RADIUS = "5";
export const DEFAULT_COUNTRY = "IN";
// Device accuracy worse than this is flagged for the user to check.
export const LOW_ACCURACY_M = 1000;

export const hasCoords = (v: LocationValue | null | undefined): v is LocationValue & { lat: number; lng: number } =>
  Boolean(v && typeof v.lat === "number" && typeof v.lng === "number" && Number.isFinite(v.lat) && Number.isFinite(v.lng));

// Countries offered in the country control (ISO 3166-1 alpha-2). India first;
// names come from the browser (Intl.DisplayNames) in the active language.
export const COUNTRIES = [
  "IN", "AE", "AU", "BD", "BR", "CA", "CN", "DE", "EG", "ES", "FJ", "FR", "GB", "HK", "ID", "IE", "IT", "JP", "KE", "KR",
  "LK", "MX", "MY", "NG", "NL", "NP", "NZ", "OM", "PH", "PK", "QA", "SA", "SE", "SG", "TH", "TR", "US", "ZA",
] as const;

export function countryName(code: string, locale: string) {
  try {
    return new Intl.DisplayNames([locale === "hi" ? "hi-IN" : "en-IN"], { type: "region" }).of(code) || code;
  } catch {
    return code;
  }
}

export function newSessionToken() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`;
}

// URL <-> location. Provider coordinates are public area centres; device
// coordinates are rounded to ~1.1 km so a shared link never reveals where
// the searcher was standing.
export function locationToParams(value: LocationValue | null, radius: string): Record<string, string> {
  if (!value) return {};
  // Typed text without coordinates: match listing text (no distance).
  if (!hasCoords(value)) return value.label.trim() ? { location: value.label.trim().slice(0, 100) } : {};
  // "Anywhere" with a place: no location filter at all.
  if (radius === "any") return {};
  const device = value.source === "device";
  const out: Record<string, string> = {
    lat: value.lat.toFixed(device ? 2 : 4),
    lng: value.lng.toFixed(device ? 2 : 4),
    radiusKm: radius,
    src: device ? "device" : "place",
  };
  if (!device && value.label) out.near = value.label.slice(0, 100);
  if (!device && value.placeId) out.placeId = value.placeId;
  if (value.country) out.country = value.country;
  return out;
}

export function locationFromParams(params: Record<string, string | undefined>): { value: LocationValue | null; radius: string } {
  const lat = params.lat !== undefined ? Number(params.lat) : NaN;
  const lng = params.lng !== undefined ? Number(params.lng) : NaN;
  if (Number.isFinite(lat) && Number.isFinite(lng)) {
    const device = params.src === "device";
    return {
      value: {
        label: device ? "" : params.near || "",
        source: device ? "device" : "provider",
        placeId: params.placeId,
        lat,
        lng,
        country: params.country,
      },
      radius: params.radiusKm || "any",
    };
  }
  if (params.location) return { value: { label: params.location, source: "manual" }, radius: "any" };
  return { value: null, radius: "any" };
}

// Frontend-only URL keys (describe the search point; never sent to the API).
export const DISPLAY_KEYS = ["near", "src", "placeId", "country"] as const;
