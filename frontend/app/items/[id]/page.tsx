import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, Calendar, MapPin, Tag } from "lucide-react";
import { ImageGallery } from "@/features/items/ImageGallery";
import { StatusBadge, TypeBadge } from "@/features/items/ItemCards";
import { Alert, EmptyState, LinkButton } from "@/components/ui";
import { serverApi } from "@/lib/server-api";
import { getT } from "@/lib/i18n/server";
import { formatDate } from "@/lib/format";
import type { Item, Viewer } from "@/lib/types";
import { ItemActions } from "./ItemActions";
import { RewardPanel } from "@/features/payments/PricingTable";
import { FALLBACK_CONNECTION_FEE_PAISE } from "@/lib/money";

type Params = Promise<{ id: string }>;

async function load(id: string, forwardCookies: boolean) {
  if (!/^\d{1,12}$/.test(id)) return { ok: false as const, status: 404, data: null };
  return serverApi<{ item: Item; viewer: Viewer }>(`/items/${id}`, { forwardCookies });
}

// Share previews use the public (cookie-less) view only.
export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { id } = await params;
  const { t } = await getT();
  const result = await load(id, false);
  if (!result.ok) return { title: t("item.notFound.title"), robots: { index: false } };
  const { item } = result.data;
  // Closed listings say so in titles and share previews.
  const closedPrefix = item.status === "returned" ? `${t("closed.meta.returned")} · ` : item.status === "closed" ? `${t("closed.meta.closed")} · ` : "";
  const title = `${closedPrefix}${t(`type.${item.type}`)}: ${item.title}`;
  const description = `${item.location} · ${item.date}${item.description ? ` · ${item.description.slice(0, 140)}` : ""}`;
  return {
    title,
    description,
    alternates: { canonical: `/items/${item.id}` },
    openGraph: { title, description, type: "article", images: item.images[0] ? [{ url: item.images[0].url, width: item.images[0].width, height: item.images[0].height }] : [] },
    twitter: { card: item.images[0] ? "summary_large_image" : "summary", title, description },
  };
}

export default async function ItemPage({ params }: { params: Params }) {
  const { id } = await params;
  const { t, locale } = await getT();
  const result = await load(id, true);

  if (!result.ok) {
    if (result.status === 404 || result.status === 400) notFound();
    const removed = result.status === 410;
    return (
      <EmptyState
        title={removed ? t("item.removed.title") : t("common.error")}
        body={removed ? t("item.removed.body") : undefined}
        action={<LinkButton href="/items">{t("item.back")}</LinkButton>}
      />
    );
  }

  const { item, viewer } = result.data;
  const pricing = await serverApi<{ connectionFeePaise: number }>("/pricing", { forwardCookies: false });
  const feePaise = pricing.ok ? pricing.data.connectionFeePaise : FALLBACK_CONNECTION_FEE_PAISE;
  return (
    <div>
      <Link href={`/items?type=${item.type}`} className="mb-4 inline-flex min-h-11 items-center gap-1 text-sm font-semibold text-primary">
        <ArrowLeft className="size-4" aria-hidden />
        {t("item.back")}
      </Link>
      {(item.status === "returned" || item.status === "closed") && (
        <div role="status" className="mb-4">
          <Alert tone={item.status === "returned" || item.closureReason === "self_recovered" || item.closureReason === "returned_external" ? "success" : "info"}>
            <p className="font-semibold" data-testid="closed-banner">
              {item.status === "returned"
                ? t("closed.returned")
                : item.closureReason === "self_recovered"
                  ? t("closed.selfRecovered")
                  : item.closureReason === "returned_external"
                    ? t("closed.external")
                    : t("closed.closed")}
            </p>
            <p className="mt-1 text-sm">{t("closed.body")}</p>
          </Alert>
        </div>
      )}
      {item.moderationState === "removed" && (
        <Alert tone="warn" className="mb-4">
          {t("item.removedNotice")}
        </Alert>
      )}
      <div className="grid gap-8 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <div className="flex flex-col gap-6">
          <ImageGallery images={item.images} title={item.title} />
          <section aria-labelledby="desc">
            <h2 id="desc" className="mb-2 text-lg font-semibold">
              {t("item.description")}
            </h2>
            <p className="whitespace-pre-line text-muted">{item.description || "—"}</p>
          </section>
        </div>
        <div className="flex flex-col gap-6">
          <div>
            <div className="flex flex-wrap gap-2">
              <TypeBadge type={item.type} t={t} />
              <StatusBadge status={item.status} t={t} />
            </div>
            <h1 className="mt-3 text-2xl font-bold tracking-tight sm:text-3xl">{item.title}</h1>
            <p className="mt-1 text-sm text-muted">{t("item.postedBy", { name: item.reporter.displayName })}</p>
            <dl className="mt-4 flex flex-col gap-3 text-sm">
              <div className="flex items-start gap-2">
                <MapPin className="mt-0.5 size-4 shrink-0 text-muted" aria-hidden />
                <dt className="sr-only">{t("item.location")}</dt>
                <dd>
                  {item.location}
                  <span className="block text-xs text-muted">{item.hasCoordinates ? t("item.approxLocation") : t("loc.textOnly")}</span>
                  {viewer.isOwner && !item.hasCoordinates && (
                    <Link href={`/items/${item.id}/edit`} className="mt-1 inline-flex min-h-11 items-center text-sm font-semibold text-primary underline-offset-4 hover:underline">
                      {t("loc.improve")}
                    </Link>
                  )}
                </dd>
              </div>
              <div className="flex items-center gap-2">
                <Calendar className="size-4 shrink-0 text-muted" aria-hidden />
                <dt>{t(item.type === "lost" ? "item.date.lost" : "item.date.found")}</dt>
                <dd className="font-medium">{formatDate(item.date, locale)}</dd>
              </div>
              <div className="flex items-center gap-2">
                <Tag className="size-4 shrink-0 text-muted" aria-hidden />
                <dt>{t("item.category")}</dt>
                <dd className="font-medium">{t(`category.${item.category}`)}</dd>
              </div>
            </dl>
          </div>
          {item.reward && item.status !== "returned" && <RewardPanel rewardPaise={item.reward.amountPaise} feePaise={feePaise} t={t} locale={locale} />}
          <ItemActions item={item} viewer={viewer} />
        </div>
      </div>
    </div>
  );
}
