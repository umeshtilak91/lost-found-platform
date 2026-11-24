"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Search } from "lucide-react";
import { useI18n } from "@/lib/i18n/client";
import { hasCoords } from "@/lib/location";
import { LocationSearchFields, useLocationSearch } from "@/features/search/LocationSearch";
import { Button, Field, Input } from "@/components/ui";

// Homepage search: item keyword, location with suggestions, "Use my
// location", radius (or Anywhere) and Search. Results open on /items with
// every filter in the URL.
export function HomeSearch() {
  const { t } = useI18n();
  const router = useRouter();
  const [q, setQ] = useState("");
  const location = useLocationSearch({});
  const [pending, startTransition] = useTransition();

  function submit(event: React.FormEvent) {
    event.preventDefault();
    const params = new URLSearchParams({ ...(q.trim() ? { q: q.trim() } : {}), ...location.params() });
    if (hasCoords(location.value) && params.has("radiusKm")) params.set("sort", "distance");
    startTransition(() => router.push(`/items${params.size ? `?${params}` : ""}`));
  }

  return (
    <form role="search" onSubmit={submit} className="mt-6 flex max-w-2xl flex-col gap-3" aria-label={t("home.searchLabel")}>
      <Field label={t("browse.keyword")}>
        {(props) => <Input {...props} name="q" type="search" value={q} onChange={(e) => setQ(e.target.value)} maxLength={100} placeholder={t("home.searchPlaceholder")} />}
      </Field>
      <LocationSearchFields state={location} idPrefix="home" />
      <Button type="submit" loading={pending} className="sm:self-start">
        <Search className="size-4" aria-hidden />
        {t("home.search")}
      </Button>
    </form>
  );
}
