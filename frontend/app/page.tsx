import Link from "next/link";
import {
  ArrowRight,
  MessageSquareLock,
  PackageSearch,
  ShieldCheck,
} from "lucide-react";
import { ItemGrid } from "@/features/items/ItemCards";
import { HeroSign } from "@/features/home/HeroSign";
import { HomeSearch } from "@/features/search/HomeSearch";
import { LinkButton } from "@/components/ui";
import { serverApi } from "@/lib/server-api";
import { getT } from "@/lib/i18n/server";
import { formatNumber } from "@/lib/format";
import type { SearchResult } from "@/lib/types";

export const dynamic = "force-dynamic";

export default async function Home() {
  const { t, locale } = await getT();
  const [stats, lost, found] = await Promise.all([
    serverApi<{ total: number; returned: number }>("/stats", {
      forwardCookies: false,
    }),
    serverApi<SearchResult>("/items?type=lost&pageSize=3", {
      forwardCookies: false,
    }),
    serverApi<SearchResult>("/items?type=found&pageSize=3", {
      forwardCookies: false,
    }),
  ]);

  return (
    <div className="flex flex-col gap-12">
      <section className="grid items-center gap-8 rounded-2xl border border-border bg-surface px-6 py-10 sm:px-10 sm:py-14 md:grid-cols-[minmax(0,1fr)_minmax(0,300px)]">
        <div className="min-w-0">
          <h1 className="max-w-2xl text-3xl font-bold tracking-tight sm:text-4xl">
            {t("home.title")}
          </h1>
          <p className="mt-3 max-w-2xl text-lg text-muted">
            {t("app.tagline")}
          </p>
          <HomeSearch />
          <div className="mt-4 flex flex-wrap gap-2">
            <LinkButton href="/report?type=lost" variant="secondary">
              {t("home.reportLost")}
            </LinkButton>
            <LinkButton href="/report?type=found" variant="secondary">
              {t("home.reportFound")}
            </LinkButton>
          </div>
          {stats.ok && (
            <dl className="mt-8 flex flex-wrap gap-8">
              <div>
                <dt className="text-sm text-muted">{t("home.stats.total")}</dt>
                <dd className="text-2xl font-bold">
                  {formatNumber(stats.data.total, locale)}
                </dd>
              </div>
              <div>
                <dt className="text-sm text-muted">
                  {t("home.stats.returned")}
                </dt>
                <dd className="text-2xl font-bold text-found">
                  {formatNumber(stats.data.returned, locale)}
                </dd>
              </div>
            </dl>
          )}
        </div>
        <div className="mx-auto w-48 sm:w-60 md:order-none md:w-full">
          <HeroSign lines={t("home.sign").split("|")} />
        </div>
      </section>

      {[
        { key: "lost" as const, title: t("home.recentLost"), result: lost },
        { key: "found" as const, title: t("home.recentFound"), result: found },
      ].map(({ key, title, result }) =>
        result.ok && result.data.items.length > 0 ? (
          <section key={key} aria-labelledby={`recent-${key}`}>
            <div className="mb-4 flex items-center justify-between">
              <h2 id={`recent-${key}`} className="text-xl font-semibold">
                {title}
              </h2>
              <Link
                href={`/items?type=${key}`}
                className="group inline-flex min-h-11 items-center gap-1 text-sm font-semibold text-primary"
              >
                {t("home.seeAll")} <ArrowRight className="size-4 transition-transform group-hover:translate-x-1" aria-hidden />
              </Link>
            </div>
            <ItemGrid
              items={result.data.items}
              t={t}
              locale={locale}
              headingLevel={3}
            />
          </section>
        ) : null,
      )}

      <section aria-labelledby="how">
        <h2 id="how" className="mb-4 text-xl font-semibold">
          {t("home.how.title")}
        </h2>
        <ol className="grid gap-4 sm:grid-cols-3">
          {[
            {
              icon: PackageSearch,
              title: t("home.how.1.title"),
              body: t("home.how.1.body"),
            },
            {
              icon: ShieldCheck,
              title: t("home.how.2.title"),
              body: t("home.how.2.body"),
            },
            {
              icon: MessageSquareLock,
              title: t("home.how.3.title"),
              body: t("home.how.3.body"),
            },
          ].map(({ icon: Icon, title, body }) => (
            <li
              key={title}
              className="rounded-xl border border-border bg-surface p-5 transition-[border-color,transform] duration-200 hover:-translate-y-0.5 hover:border-primary/50"
            >
              <Icon className="size-6 text-primary" aria-hidden />
              <h3 className="mt-3 font-semibold">{title}</h3>
              <p className="mt-1 text-sm text-muted">{body}</p>
            </li>
          ))}
        </ol>
      </section>
    </div>
  );
}
