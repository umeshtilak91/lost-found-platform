"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import clsx from "clsx";
import { Check, SlidersHorizontal, X } from "lucide-react";
import { Button, Field, Input, Select } from "@/components/ui";
import { LocationSearchFields, useLocationSearch } from "@/features/search/LocationSearch";
import { useI18n } from "@/lib/i18n/client";
import { hasCoords } from "@/lib/location";
import { CATEGORIES } from "@/lib/types";

export type Filters = Partial<
  Record<
    "type" | "q" | "category" | "location" | "from" | "to" | "sort" | "status" | "lat" | "lng" | "radiusKm" | "near" | "src" | "placeId" | "country",
    string
  >
>;

const LOCATION_KEYS: (keyof Filters)[] = ["location", "lat", "lng", "radiusKm", "near", "src", "placeId", "country"];
const ADVANCED: (keyof Filters)[] = ["category", "from", "to", "status"];

function toHref(filters: Filters) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) if (value) params.set(key, value);
  return `/items${params.size ? `?${params}` : ""}`;
}

// Selectable pill (toggle button; one active per group).
function Chip({ selected, onSelect, children }: { selected: boolean; onSelect: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onSelect}
      className={clsx(
        "inline-flex min-h-10 items-center gap-1.5 rounded-full border px-3.5 text-sm font-medium transition-[background-color,border-color,color,transform] duration-150 active:scale-95",
        selected
          ? "border-primary bg-primary text-primary-contrast"
          : "border-border bg-surface text-text hover:border-primary/60 hover:bg-surface-muted"
      )}
    >
      {selected && <Check className="size-4" aria-hidden />}
      {children}
    </button>
  );
}

// Filters live in the URL, so every result page is shareable and works with
// the back button. Submitting navigates; the server renders the results.
export function SearchFilters({ initial }: { initial: Filters }) {
  const { t, locale } = useI18n();
  const router = useRouter();
  const [values, setValues] = useState<Filters>(() => Object.fromEntries(Object.entries(initial).filter(([k]) => !LOCATION_KEYS.includes(k as keyof Filters))));
  const location = useLocationSearch(initial);
  const activeAdvanced = ADVANCED.filter((key) => initial[key] && !(key === "status" && initial.status === "active")).length;
  const [expanded, setExpanded] = useState(activeAdvanced > 0);
  const [pending, startTransition] = useTransition();

  const set = (key: keyof Filters) => (event: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setValues((current) => ({ ...current, [key]: event.target.value }));

  // Build the full filter set from the form state.
  function current(overrides: Filters = {}): Filters {
    const loc = location.params();
    const next: Filters = { ...values, ...loc, ...overrides };
    const distanceSearch = Boolean(loc.radiusKm);
    if (!loc.lat && next.sort === "distance") delete next.sort; // nearest-first needs a point
    if (distanceSearch && !next.sort) next.sort = "distance";
    return next;
  }
  // Navigations run in a transition: the results stay on screen (dimmed via
  // data-search-pending) with a progress bar until the new page is ready.
  const navigate = (next: Filters) => startTransition(() => router.push(toHref(next)));
  const choose = (key: keyof Filters, value: string) => {
    setValues((v) => ({ ...v, [key]: value }));
    navigate(current({ [key]: value }));
  };

  const hasNear = hasCoords(location.value);
  const dateFmt = (d: string) => new Intl.DateTimeFormat(locale === "hi" ? "hi-IN" : "en-IN", { day: "numeric", month: "short", timeZone: "UTC" }).format(new Date(`${d}T00:00:00Z`));

  // Applied filters (from the URL) as removable chips.
  const applied: { key: string; label: string; without: Filters }[] = [];
  const drop = (...keys: (keyof Filters)[]) => Object.fromEntries(Object.entries(initial).filter(([k]) => !keys.includes(k as keyof Filters))) as Filters;
  if (initial.q) applied.push({ key: "q", label: `“${initial.q}”`, without: drop("q") });
  if (initial.type) applied.push({ key: "type", label: t(`type.${initial.type}` as "type.lost"), without: drop("type") });
  if (initial.category) applied.push({ key: "category", label: t(`category.${initial.category}` as "category.other"), without: drop("category") });
  if (initial.lat && initial.lng && initial.radiusKm) {
    const label = initial.src === "device" || !initial.near ? t("loc.chipNearMe", { km: initial.radiusKm }) : t("loc.chipNear", { km: initial.radiusKm, place: initial.near.split(",")[0] });
    applied.push({ key: "near", label: `📍 ${label}`, without: drop(...LOCATION_KEYS, "sort") });
  } else if (initial.location) {
    applied.push({ key: "location", label: `📍 ${t("loc.chipText", { text: initial.location })}`, without: drop("location") });
  }
  if (initial.from || initial.to) applied.push({ key: "dates", label: `${initial.from ? dateFmt(initial.from) : "…"} – ${initial.to ? dateFmt(initial.to) : "…"}`, without: drop("from", "to") });
  if (initial.status && initial.status !== "active") applied.push({ key: "status", label: t(`status.${initial.status}` as "status.open"), without: drop("status") });
  const anywhere = !initial.lat && !initial.location;

  return (
    <div className="flex flex-col gap-3" data-search-pending={pending || undefined}>
      {pending && (
        <div role="progressbar" aria-label={t("common.loading")} className="fixed inset-x-0 top-0 z-50 h-1 overflow-hidden bg-primary/20">
          <div className="progress-indeterminate h-full w-1/3 bg-primary" />
        </div>
      )}
      <form
        role="search"
        onSubmit={(event) => {
          event.preventDefault();
          navigate(current());
        }}
        className="rounded-xl border border-border bg-surface p-4"
      >
        <div className="flex flex-col gap-3">
          <Field label={t("browse.keyword")}>
            {(props) => <Input {...props} type="search" value={values.q || ""} onChange={set("q")} placeholder={t("home.searchPlaceholder")} maxLength={100} />}
          </Field>
          <LocationSearchFields state={location} idPrefix="browse" />
          <div className="flex flex-wrap gap-2">
            <Button type="submit">{t("home.search")}</Button>
            <Button type="button" variant="secondary" aria-expanded={expanded} aria-controls="more-filters" onClick={() => setExpanded((v) => !v)}>
              <SlidersHorizontal className="size-4" aria-hidden />
              {activeAdvanced ? t("filters.count", { count: activeAdvanced }) : t("browse.filters")}
            </Button>
          </div>
        </div>

        <div role="group" aria-label={t("browse.type")} className="mt-3 flex flex-wrap gap-2">
          {(["", "lost", "found"] as const).map((type) => (
            <Chip key={type || "all"} selected={(values.type || "") === type} onSelect={() => choose("type", type)}>
              {type ? t(`type.${type}`) : t("type.all")}
            </Chip>
          ))}
        </div>

        <div id="more-filters" hidden={!expanded} className="menu-in mt-4 border-t border-border pt-4">
          <div role="group" aria-label={t("browse.category")} className="flex flex-wrap gap-2">
            <Chip selected={!values.category} onSelect={() => choose("category", "")}>
              {t("category.any")}
            </Chip>
            {CATEGORIES.map((category) => (
              <Chip key={category} selected={values.category === category} onSelect={() => choose("category", category)}>
                {t(`category.${category}`)}
              </Chip>
            ))}
          </div>
          <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Field label={t("browse.from")}>{(props) => <Input {...props} type="date" value={values.from || ""} onChange={set("from")} />}</Field>
            <Field label={t("browse.to")}>{(props) => <Input {...props} type="date" value={values.to || ""} onChange={set("to")} />}</Field>
            <Field label={t("browse.status")}>
              {(props) => (
                <Select {...props} value={values.status || "active"} onChange={set("status")}>
                  <option value="active">{t("status.active")}</option>
                  <option value="open">{t("status.open")}</option>
                  <option value="claimed">{t("status.claimed")}</option>
                  <option value="returned">{t("status.returned")}</option>
                  <option value="all">{t("status.all")}</option>
                </Select>
              )}
            </Field>
            <Field label={t("browse.sort")}>
              {(props) => (
                <Select {...props} value={values.sort || (hasNear && initial.lat ? "distance" : "newest")} onChange={set("sort")}>
                  <option value="newest">{t("browse.sort.newest")}</option>
                  <option value="oldest">{t("browse.sort.oldest")}</option>
                  <option value="date">{t("browse.sort.date")}</option>
                  {hasNear && <option value="distance">{t("browse.sort.distance")}</option>}
                </Select>
              )}
            </Field>
            <div className="flex flex-wrap items-end gap-2 lg:col-span-4">
              <Button type="submit">{t("browse.apply")}</Button>
              <Button
                type="button"
                variant="ghost"
                onClick={() => {
                  location.reset();
                  navigate({ type: values.type });
                }}
              >
                {t("browse.reset")}
              </Button>
            </div>
          </div>
        </div>
      </form>

      <div className="flex flex-wrap items-center gap-2" aria-label={t("filters.active")} role="group">
        {anywhere && (
          <span className="inline-flex min-h-9 items-center gap-1.5 rounded-full border border-border px-3 text-sm text-muted" data-testid="anywhere-chip">
            🌐 {t("loc.chipAnywhere")}
          </span>
        )}
        {applied.map((filter) => (
          <a
            key={filter.key}
            href={toHref(filter.without)}
            onClick={(event) => {
              event.preventDefault();
              if (filter.key === "near" || filter.key === "location") location.reset();
              navigate(filter.without);
            }}
            className="inline-flex min-h-9 items-center gap-1.5 rounded-full border border-primary/40 bg-info-bg px-3 text-sm font-medium transition-colors hover:border-lost hover:text-lost"
            aria-label={t("filters.remove", { label: filter.label })}
          >
            {filter.label}
            <X className="size-3.5" aria-hidden />
          </a>
        ))}
        {applied.length > 1 && (
          <button
            type="button"
            onClick={() => {
              location.reset();
              navigate({});
            }}
            className="min-h-9 px-2 text-sm font-medium text-muted underline-offset-4 hover:text-text hover:underline"
          >
            {t("browse.reset")}
          </button>
        )}
      </div>
    </div>
  );
}
