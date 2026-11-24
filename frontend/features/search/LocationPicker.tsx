"use client";

// Reusable location selector (homepage search, browse filters, report/edit).
//
// - Accessible combobox (ARIA 1.2): suggestions after 3 characters, 300 ms
//   debounce, aborted + sequence-checked requests (stale answers are ignored),
//   loading / empty / error+retry states, arrow keys, Enter, Escape, pointer.
// - Suggestions come from our API (/api/places/*), which holds the provider
//   key. One autocomplete session token per search, closed by the details call.
// - Editing the text of a selected suggestion clears its place identity and
//   coordinates: the value becomes typed text until another selection.
// - "Use my location" asks for permission only when pressed, handles every
//   failure, and never overwrites a selection the user made while it waited.

import { useCallback, useEffect, useId, useRef, useState } from "react";
import clsx from "clsx";
import { Globe2, LocateFixed, MapPin, RotateCw, X } from "lucide-react";
import { api, ApiError } from "@/lib/api";
import { useI18n } from "@/lib/i18n/client";
import {
  COUNTRIES,
  countryName,
  hasCoords,
  LOW_ACCURACY_M,
  newSessionToken,
  type LocationValue,
  type Suggestion,
} from "@/lib/location";
import { Alert, Button, Select } from "@/components/ui";

type PlacesConfig = { enabled: boolean; provider: string | null; attribution: string | null; minChars: number };
type ListState = "idle" | "short" | "loading" | "ready" | "empty" | "error";
type GeoState =
  | { kind: "idle" }
  | { kind: "locating" }
  | { kind: "error"; reason: "denied" | "unavailable" | "timeout" | "unsupported" | "insecure" }
  | { kind: "superseded"; position: GeolocationPosition }
  | { kind: "unnamed" };

let configPromise: Promise<PlacesConfig> | null = null;
function loadConfig() {
  configPromise ??= api<PlacesConfig>("/places/config").catch(() => {
    configPromise = null;
    return { enabled: false, provider: null, attribution: null, minChars: 3 };
  });
  return configPromise;
}

const DEBOUNCE_MS = 300;

export function LocationPicker({
  value,
  onChange,
  label,
  hint,
  error,
  required,
  mode,
  country,
  onCountryChange,
  inputId,
}: {
  value: LocationValue | null;
  onChange: (value: LocationValue | null) => void;
  label: string;
  hint?: string;
  error?: string;
  required?: boolean;
  mode: "search" | "incident";
  country: string;
  onCountryChange: (country: string) => void;
  inputId?: string;
}) {
  const { t, locale } = useI18n();
  const autoId = useId();
  const id = inputId || `${autoId}-loc`;
  const listId = `${id}-list`;
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const statusId = `${id}-status`;

  const [config, setConfig] = useState<PlacesConfig | null>(null);
  const [text, setText] = useState(value?.label ?? "");
  const [open, setOpen] = useState(false);
  const [list, setList] = useState<ListState>("idle");
  const [listError, setListError] = useState<{ retryable: boolean; offline: boolean } | null>(null);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [active, setActive] = useState(-1);
  const [resolving, setResolving] = useState(false);
  const [geo, setGeo] = useState<GeoState>({ kind: "idle" });

  const seq = useRef(0); // latest autocomplete request
  const abort = useRef<AbortController | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const token = useRef<string | null>(null);
  const version = useRef(0); // bumps on every user edit/selection
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    loadConfig().then(setConfig);
    return () => {
      abort.current?.abort();
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  // Keep the text in sync when the parent replaces the value (e.g. reset, URL).
  const lastLabel = useRef(value?.label ?? "");
  useEffect(() => {
    if ((value?.label ?? "") !== lastLabel.current) {
      lastLabel.current = value?.label ?? "";
      setText(value?.label ?? "");
    }
  }, [value?.label]);

  const emit = useCallback(
    (next: LocationValue | null) => {
      lastLabel.current = next?.label ?? "";
      onChange(next);
    },
    [onChange]
  );

  const enabled = Boolean(config?.enabled);
  const minChars = config?.minChars ?? 3;

  const fetchSuggestions = useCallback(
    async (input: string) => {
      abort.current?.abort();
      const trimmed = input.trim();
      if (!enabled) return;
      if ([...trimmed].length < minChars) {
        seq.current += 1;
        setSuggestions([]);
        setList(trimmed ? "short" : "idle");
        return;
      }
      const mySeq = ++seq.current;
      const controller = new AbortController();
      abort.current = controller;
      token.current ??= newSessionToken();
      setList("loading");
      setListError(null);
      const params = new URLSearchParams({ input: trimmed, sessionToken: token.current, country, lang: locale });
      if (hasCoords(value)) {
        params.set("lat", value.lat.toFixed(2));
        params.set("lng", value.lng.toFixed(2));
      }
      try {
        const res = await api<{ suggestions: Suggestion[] }>(`/places/autocomplete?${params}`, { signal: controller.signal });
        if (mySeq !== seq.current) return; // a newer request owns the list
        setSuggestions(res.suggestions);
        setActive(-1);
        setList(res.suggestions.length ? "ready" : "empty");
      } catch (err) {
        if ((err as Error).name === "AbortError" || mySeq !== seq.current) return;
        const offline = err instanceof ApiError && err.code === "network";
        setListError({ retryable: offline || Boolean(err instanceof ApiError && err.details.retryable), offline });
        setSuggestions([]);
        setList("error");
      }
    },
    [enabled, minChars, country, locale, value]
  );

  function onTextChange(next: string) {
    version.current += 1;
    setText(next);
    setOpen(true);
    if (geo.kind !== "idle" && geo.kind !== "locating") setGeo({ kind: "idle" });
    // A device position keeps its coordinates while the user names the area;
    // a chosen suggestion loses its identity as soon as its text changes.
    if (value?.source === "device" && hasCoords(value)) emit({ ...value, label: next });
    else emit(next.trim() || mode === "incident" ? { label: next, source: "manual", country } : null);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => fetchSuggestions(next), DEBOUNCE_MS);
  }

  async function choose(s: Suggestion) {
    version.current += 1;
    const mine = version.current;
    setOpen(false);
    setText(s.label);
    setResolving(true);
    seq.current += 1; // drop any in-flight list
    abort.current?.abort();
    try {
      const params = new URLSearchParams({ placeId: s.placeId, lang: locale });
      if (token.current) params.set("sessionToken", token.current);
      const res = await api<{ place: { placeId: string; lat: number; lng: number; country: string | null } }>(`/places/details?${params}`);
      if (mine !== version.current) return; // user moved on
      emit({ label: s.label, source: "provider", placeId: res.place.placeId, lat: res.place.lat, lng: res.place.lng, country: res.place.country || country });
      setList("idle");
      setSuggestions([]);
    } catch (err) {
      if (mine !== version.current) return;
      emit({ label: s.label, source: "manual", country });
      const offline = err instanceof ApiError && err.code === "network";
      setListError({ retryable: true, offline });
      setList("error");
    } finally {
      token.current = null; // the details call ends the billing session
      if (mine === version.current) setResolving(false);
    }
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    const showing = open && list === "ready" && suggestions.length > 0;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      if (!open) setOpen(true);
      if (suggestions.length) setActive((i) => (i + 1) % suggestions.length);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      if (suggestions.length) setActive((i) => (i <= 0 ? suggestions.length - 1 : i - 1));
    } else if (event.key === "Enter" && showing && active >= 0) {
      event.preventDefault();
      choose(suggestions[active]);
    } else if (event.key === "Escape") {
      if (open) {
        event.preventDefault();
        setOpen(false);
        setActive(-1);
      }
    } else if (event.key === "Tab") {
      setOpen(false);
    }
  }

  function clear() {
    version.current += 1;
    seq.current += 1;
    abort.current?.abort();
    setText("");
    setSuggestions([]);
    setList("idle");
    setGeo({ kind: "idle" });
    emit(mode === "incident" ? { label: "", source: "manual", country } : null);
    inputRef.current?.focus();
  }

  async function applyPosition(position: GeolocationPosition) {
    version.current += 1;
    const mine = version.current;
    const lat = position.coords.latitude;
    const lng = position.coords.longitude;
    const accuracyM = Math.round(position.coords.accuracy || 0);
    let name = "";
    let detectedCountry: string | undefined;
    let named = false;
    if (enabled) {
      try {
        const params = new URLSearchParams({ lat: lat.toFixed(5), lng: lng.toFixed(5), lang: locale });
        const res = await api<{ place: { label: string | null; country: string | null } | null }>(`/places/reverse?${params}`);
        if (res.place?.label) {
          name = res.place.label;
          detectedCountry = res.place.country || undefined;
          named = true;
        }
      } catch {
        // handled below: position kept, the user names the area
      }
    }
    if (mine !== version.current) return;
    const fallback = mode === "search" ? t("loc.yourLocation") : "";
    const next: LocationValue = { label: name || fallback, source: "device", lat, lng, accuracyM, country: detectedCountry || country };
    setText(next.label);
    emit(next);
    if (detectedCountry && detectedCountry !== country && (COUNTRIES as readonly string[]).includes(detectedCountry)) onCountryChange(detectedCountry);
    setGeo(named || mode === "search" ? { kind: "idle" } : { kind: "unnamed" });
    if (!named && mode === "incident") requestAnimationFrame(() => inputRef.current?.focus());
  }

  function locate() {
    if (typeof window !== "undefined" && !window.isSecureContext) return setGeo({ kind: "error", reason: "insecure" });
    if (!("geolocation" in navigator)) return setGeo({ kind: "error", reason: "unsupported" });
    const started = version.current;
    setGeo({ kind: "locating" });
    navigator.geolocation.getCurrentPosition(
      (position) => {
        // The user chose or typed something while we waited: ask, don't replace.
        if (version.current !== started) return setGeo({ kind: "superseded", position });
        setGeo({ kind: "idle" });
        applyPosition(position);
      },
      (err) => {
        const reason = err.code === err.PERMISSION_DENIED ? "denied" : err.code === err.TIMEOUT ? "timeout" : "unavailable";
        setGeo({ kind: "error", reason });
      },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 }
    );
  }

  const showList = open && enabled && list !== "idle";
  const describedBy = [hint ? hintId : null, error ? errorId : null, statusId].filter(Boolean).join(" ");
  const lowAccuracy = value?.source === "device" && (value.accuracyM ?? 0) > LOW_ACCURACY_M;
  const distance = (m: number) => (m < 1000 ? `${Math.max(1, Math.round(m))} m` : `${m >= 10000 ? Math.round(m / 1000) : Math.round(m / 100) / 10} km`);

  return (
    <div className="flex flex-col gap-1.5" data-testid="location-picker">
      <label htmlFor={id} className="text-sm font-medium">
        {label}
      </label>
      <div className="flex flex-col gap-2 sm:flex-row">
        <div className="relative flex-1">
          <MapPin className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted" aria-hidden />
          <input
            ref={inputRef}
            id={id}
            role="combobox"
            type="text"
            autoComplete="off"
            spellCheck={false}
            aria-autocomplete="list"
            aria-expanded={showList && list === "ready"}
            aria-controls={listId}
            aria-activedescendant={showList && active >= 0 ? `${id}-opt-${active}` : undefined}
            aria-describedby={describedBy}
            aria-invalid={error ? true : undefined}
            aria-busy={list === "loading" || resolving || undefined}
            required={required}
            maxLength={120}
            value={text}
            placeholder={enabled ? t("loc.placeholder") : t("loc.placeholderManual")}
            onChange={(e) => onTextChange(e.target.value)}
            onKeyDown={onKeyDown}
            onFocus={() => suggestions.length && setOpen(true)}
            onBlur={() => setTimeout(() => setOpen(false), 120)}
            className="min-h-12 w-full rounded-lg border border-border bg-bg pl-9 pr-10 text-base"
          />
          {text && (
            <button type="button" onClick={clear} aria-label={t("loc.clear")} className="absolute right-1 top-1/2 inline-flex size-10 -translate-y-1/2 items-center justify-center rounded-md text-muted hover:text-text">
              <X className="size-4" aria-hidden />
            </button>
          )}
          {showList && (
            <div className="absolute inset-x-0 top-full z-30 mt-1 overflow-hidden rounded-lg border border-border bg-surface shadow-lg">
              {list === "ready" && (
                <ul id={listId} role="listbox" aria-label={t("loc.suggestions")} className="max-h-72 overflow-auto py-1">
                  {suggestions.map((s, index) => (
                    <li
                      key={s.placeId}
                      id={`${id}-opt-${index}`}
                      role="option"
                      aria-selected={index === active}
                      onMouseDown={(e) => e.preventDefault()}
                      onMouseEnter={() => setActive(index)}
                      onClick={() => choose(s)}
                      className={clsx("flex min-h-12 cursor-pointer items-start gap-2 px-3 py-2", index === active ? "bg-info-bg" : "hover:bg-surface-muted")}
                    >
                      <MapPin className="mt-0.5 size-4 shrink-0 text-muted" aria-hidden />
                      <span className="min-w-0">
                        <span className="block font-medium">{s.primary}</span>
                        {s.secondary && <span className="block truncate text-sm text-muted">{s.secondary}</span>}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
              {list !== "ready" && <ul id={listId} role="listbox" aria-label={t("loc.suggestions")} hidden />}
              {list === "loading" && <p className="px-3 py-3 text-sm text-muted">{t("loc.loading")}</p>}
              {list === "short" && <p className="px-3 py-3 text-sm text-muted">{t("loc.short", { n: minChars })}</p>}
              {list === "empty" && <p className="px-3 py-3 text-sm text-muted">{t("loc.empty")}</p>}
              {list === "error" && (
                <div className="flex flex-wrap items-center gap-2 px-3 py-3 text-sm">
                  <span>{listError?.offline ? t("loc.offline") : listError?.retryable ? t("loc.busy") : t("loc.unavailable")}</span>
                  {listError?.retryable && (
                    <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => fetchSuggestions(text)} className="inline-flex min-h-10 items-center gap-1 font-semibold text-primary">
                      <RotateCw className="size-4" aria-hidden />
                      {t("loc.retry")}
                    </button>
                  )}
                </div>
              )}
              {config?.attribution && (list === "ready" || list === "empty") && (
                <p className="border-t border-border px-3 py-1.5 text-right text-xs text-muted" data-testid="provider-attribution">
                  {config.attribution}
                </p>
              )}
            </div>
          )}
        </div>
        <Button type="button" variant="secondary" onClick={locate} loading={geo.kind === "locating"}>
          <LocateFixed className="size-4" aria-hidden />
          {geo.kind === "locating" ? t("loc.locating") : t("loc.useMine")}
        </Button>
      </div>

      <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
        <label className="inline-flex items-center gap-1.5">
          <Globe2 className="size-3.5" aria-hidden />
          <span>{t("loc.country")}</span>
          <Select
            value={country}
            onChange={(e) => {
              onCountryChange(e.target.value);
              token.current = null;
              setSuggestions([]);
              setList("idle");
            }}
            className="min-h-9 py-1 text-sm"
            aria-label={t("loc.country")}
          >
            {[...COUNTRIES]
              .sort((a, b) => (a === "IN" ? -1 : b === "IN" ? 1 : countryName(a, locale).localeCompare(countryName(b, locale))))
              .map((code) => (
                <option key={code} value={code}>
                  {countryName(code, locale)}
                </option>
              ))}
          </Select>
        </label>
      </div>

      <p id={statusId} className="text-sm" aria-live="polite" data-testid="location-status">
        {resolving ? (
          <span className="text-muted">{t("loc.resolving")}</span>
        ) : value && hasCoords(value) && value.source === "provider" ? (
          <span className="text-found">{t("loc.selected")}</span>
        ) : value && hasCoords(value) && value.source === "device" ? (
          <span className="text-found">
            {value.accuracyM ? t("loc.deviceAccuracy", { distance: distance(value.accuracyM) }) : t("loc.device")}
            <button type="button" onClick={clear} className="ml-2 font-semibold text-primary underline-offset-4 hover:underline">
              {t("loc.removePosition")}
            </button>
          </span>
        ) : value?.label?.trim() ? (
          <span className="text-muted">{mode === "search" ? t("loc.typedSearch") : t("loc.typedIncident")}</span>
        ) : null}
      </p>
      {hint && (
        <p id={hintId} className="text-xs text-muted">
          {hint}
        </p>
      )}
      {error && (
        <p id={errorId} className="text-sm text-lost">
          {error}
        </p>
      )}
      {config && !config.enabled && <p className="text-xs text-muted">{t("loc.disabled")}</p>}

      {lowAccuracy && <Alert tone="warn">{t("loc.lowAccuracy", { distance: distance(value!.accuracyM!) })}</Alert>}
      {geo.kind === "unnamed" && <Alert tone="warn">{t("loc.unnamed")}</Alert>}
      {geo.kind === "error" && <Alert tone="warn">{t(`loc.geo.${geo.reason}` as "loc.geo.denied")}</Alert>}
      {geo.kind === "superseded" && (
        <Alert tone="info">
          {t("loc.superseded")}
          <span className="mt-2 flex flex-wrap gap-2">
            <Button
              type="button"
              variant="secondary"
              onClick={() => {
                const position = geo.position;
                setGeo({ kind: "idle" });
                applyPosition(position);
              }}
            >
              {t("loc.useDetected")}
            </Button>
            <Button type="button" variant="ghost" onClick={() => setGeo({ kind: "idle" })}>
              {t("loc.keepMine")}
            </Button>
          </span>
        </Alert>
      )}
    </div>
  );
}
