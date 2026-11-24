import type { Metadata } from "next";
import { ItemGrid, Pagination } from "@/features/items/ItemCards";
import { SearchFilters, type Filters } from "@/features/search/SearchFilters";
import { Alert, EmptyState, LinkButton, PageHeader } from "@/components/ui";
import { serverApi } from "@/lib/server-api";
import { getT } from "@/lib/i18n/server";
import type { SearchResult } from "@/lib/types";

import { DISPLAY_KEYS } from "@/lib/location";

const ALLOWED = ["type", "q", "category", "location", "from", "to", "sort", "status", "lat", "lng", "radiusKm", "page", ...DISPLAY_KEYS] as const;

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

function pick(params: Record<string, string | string[] | undefined>) {
  const out: Record<string, string> = {};
  for (const key of ALLOWED) {
    const value = params[key];
    const single = Array.isArray(value) ? value[0] : value;
    if (single) out[key] = single.slice(0, 120);
  }
  return out;
}

export async function generateMetadata({ searchParams }: { searchParams: SearchParams }): Promise<Metadata> {
  const { t } = await getT();
  const { type } = pick(await searchParams);
  return { title: type === "lost" ? t("nav.lost") : type === "found" ? t("nav.found") : t("browse.title") };
}

export default async function ItemsPage({ searchParams }: { searchParams: SearchParams }) {
  const { t, locale } = await getT();
  const params = pick(await searchParams);
  // Display-only keys (place name, source) describe the search point for the UI.
  const apiParams = Object.fromEntries(Object.entries(params).filter(([key]) => !(DISPLAY_KEYS as readonly string[]).includes(key)));
  const query = new URLSearchParams({ ...apiParams, pageSize: "12" });
  let result = await serverApi<SearchResult>(`/items?${query}`, { forwardCookies: false });

  // Invalid filters from a hand-edited/stale URL: show results without them.
  let invalid = false;
  if (!result.ok && result.status === 400) {
    invalid = true;
    result = await serverApi<SearchResult>(`/items?${new URLSearchParams(params.type ? { type: params.type, pageSize: "12" } : { pageSize: "12" })}`, {
      forwardCookies: false,
    });
  }

  const title = params.type === "lost" ? t("nav.lost") : params.type === "found" ? t("nav.found") : t("browse.title");
  const hrefFor = (page: number) => {
    const next = new URLSearchParams(params);
    next.set("page", String(page));
    return `/items?${next}`;
  };
  const filters = Object.fromEntries(Object.entries(params).filter(([key]) => key !== "page"));

  return (
    <div>
      <PageHeader title={title}>
        <LinkButton href={`/report${params.type ? `?type=${params.type}` : ""}`}>{t("nav.report")}</LinkButton>
      </PageHeader>
      <SearchFilters key={JSON.stringify(filters)} initial={filters as Filters} />
      {invalid && (
        <Alert tone="warn" className="mt-4">
          {t("browse.invalid")}
        </Alert>
      )}
      <div id="search-results" className="mt-6">
        {!result.ok ? (
          <Alert tone="error">{t("browse.error")}</Alert>
        ) : result.data.items.length === 0 ? (
          <EmptyState title={t("browse.empty.title")} body={t("browse.empty.body")} action={<LinkButton href="/report">{t("nav.report")}</LinkButton>} />
        ) : (
          <>
            <p className="mb-4 text-sm text-muted" aria-live="polite">
              {result.data.total === 1 ? t("browse.resultsOne") : t("browse.results", { count: result.data.total })}
            </p>
            <ItemGrid items={result.data.items} t={t} locale={locale} />
            <Pagination page={result.data.page} totalPages={result.data.totalPages} hrefFor={hrefFor} t={t} />
          </>
        )}
      </div>
    </div>
  );
}
