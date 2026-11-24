"use client";

// Location + radius pair used by the homepage search and the browse filters.
// "Anywhere" is an explicit radius choice; picking a place switches an
// untouched "Anywhere" to the 5 km default.

import { useRef, useState } from "react";
import { useI18n } from "@/lib/i18n/client";
import { DEFAULT_COUNTRY, DEFAULT_RADIUS, hasCoords, locationFromParams, locationToParams, RADIUS_OPTIONS, type LocationValue } from "@/lib/location";
import { LocationPicker } from "@/features/search/LocationPicker";
import { Field, Select } from "@/components/ui";

export function useLocationSearch(initial: Record<string, string | undefined>) {
  const start = locationFromParams(initial);
  const [value, setValue] = useState<LocationValue | null>(start.value);
  const [radius, setRadius] = useState<string>(start.radius);
  // A ref, not state: a place that resolves late must see the user's latest
  // radius choice (e.g. "Anywhere" picked while the place was loading).
  const radiusTouched = useRef(Boolean(initial.radiusKm));
  const [country, setCountry] = useState(initial.country || DEFAULT_COUNTRY);

  function onLocation(next: LocationValue | null) {
    setValue(next);
    if (radiusTouched.current) return;
    setRadius(hasCoords(next) ? DEFAULT_RADIUS : "any");
  }
  return {
    value,
    radius,
    country,
    setCountry,
    onLocation,
    setRadius: (r: string) => {
      radiusTouched.current = true;
      setRadius(r);
    },
    params: () => locationToParams(value, radius),
    reset: () => {
      setValue(null);
      setRadius("any");
      radiusTouched.current = false;
    },
  };
}

export type LocationSearchState = ReturnType<typeof useLocationSearch>;

export function LocationSearchFields({ state, idPrefix }: { state: LocationSearchState; idPrefix: string }) {
  const { t } = useI18n();
  const canRadius = hasCoords(state.value);
  return (
    <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_10rem] sm:items-start">
      <LocationPicker
        inputId={`${idPrefix}-location`}
        mode="search"
        label={t("loc.where")}
        value={state.value}
        onChange={state.onLocation}
        country={state.country}
        onCountryChange={state.setCountry}
      />
      <Field label={t("loc.radius")}>
        {(props) => (
          <Select {...props} value={canRadius ? state.radius : "any"} onChange={(e) => state.setRadius(e.target.value)} data-testid="radius">
            <option value="any">{t("loc.anywhere")}</option>
            {RADIUS_OPTIONS.map((km) => (
              <option key={km} value={km} disabled={!canRadius}>
                {t("loc.withinKm", { km })}
              </option>
            ))}
          </Select>
        )}
      </Field>
    </div>
  );
}
