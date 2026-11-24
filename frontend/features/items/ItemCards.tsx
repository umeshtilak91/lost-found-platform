import Link from "next/link";
import { Calendar, ImageOff, MapPin } from "lucide-react";
import { Badge } from "@/components/ui";
import { ViewedBadge } from "@/features/items/ViewedBadge";
import { RewardTag } from "@/features/payments/PricingTable";
import { formatDate } from "@/lib/format";
import type { Locale, MessageKey } from "@/lib/i18n/messages";
import type { Item, ItemStatus, ItemType } from "@/lib/types";

type T = (key: MessageKey, vars?: Record<string, string | number>) => string;

export function TypeBadge({ type, t }: { type: ItemType; t: T }) {
  return <Badge tone={type === "lost" ? "lost" : "found"}>{t(`type.${type}`)}</Badge>;
}

export function StatusBadge({ status, t }: { status: ItemStatus; t: T }) {
  if (status === "open") return null;
  return (
    <span className="inline-flex">
      <Badge tone={status === "returned" ? "success" : status === "claimed" ? "warn" : "neutral"}>
        {status === "returned" ? "🎉 " : ""}
        {t(`status.${status}`)}
      </Badge>
    </span>
  );
}

export function ItemCard({ item, t, locale, headingLevel = 2 }: { item: Item; t: T; locale: Locale; headingLevel?: 2 | 3 }) {
  const Heading = `h${headingLevel}` as "h2" | "h3";
  const image = item.images[0];
  return (
    <article className="group relative flex h-full flex-col overflow-hidden rounded-xl border border-border bg-surface shadow-sm transition-[transform,box-shadow,border-color] duration-200 ease-out hover:-translate-y-1 hover:border-primary/60 hover:shadow-lg focus-within:-translate-y-1 focus-within:border-primary focus-within:ring-2 focus-within:ring-primary active:translate-y-0 active:scale-[0.98] motion-reduce:hover:translate-y-0 motion-reduce:focus-within:translate-y-0">
      <div className="relative aspect-[4/3] overflow-hidden bg-surface-muted">
        <ViewedBadge id={item.id} />
        {image ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={image.thumbUrl} alt="" loading="lazy" decoding="async" width={480} height={360} className="size-full object-cover transition-transform duration-300 ease-out group-hover:scale-105 motion-reduce:group-hover:scale-100" />
        ) : (
          <div className="flex size-full items-center justify-center text-muted">
            <ImageOff className="size-8" aria-hidden />
            <span className="sr-only">{t("item.noPhotos")}</span>
          </div>
        )}
      </div>
      <div className="flex flex-1 flex-col gap-2 p-4">
        <div className="flex flex-wrap gap-1.5">
          <TypeBadge type={item.type} t={t} />
          <StatusBadge status={item.status} t={t} />
          <Badge>{t(`category.${item.category}`)}</Badge>
        </div>
        <Heading className="text-base font-semibold leading-snug">
          <Link href={`/items/${item.id}`} className="transition-colors after:absolute after:inset-0 group-hover:text-primary focus:outline-none">
            {item.title}
          </Link>
        </Heading>
        <RewardTag reward={item.reward} t={t} locale={locale} />
        <p className="flex items-center gap-1.5 text-sm text-muted">
          <MapPin className="size-4 shrink-0" aria-hidden />
          <span className="truncate">{item.location}</span>
          {item.distanceKm !== undefined && (
            <span className="shrink-0" data-testid="distance">
              · {item.distanceKm <= 1 ? t("item.distanceUnder1") : t("item.distanceApprox", { km: item.distanceKm })}
            </span>
          )}
        </p>
        <p className="flex items-center gap-1.5 text-sm text-muted">
          <Calendar className="size-4 shrink-0" aria-hidden />
          <span>
            {t(item.type === "lost" ? "item.date.lost" : "item.date.found")} {formatDate(item.date, locale)}
          </span>
        </p>
      </div>
    </article>
  );
}

export function ItemGrid({ items, t, locale, headingLevel }: { items: Item[]; t: T; locale: Locale; headingLevel?: 2 | 3 }) {
  return (
    <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {items.map((item) => (
        <li key={item.id} className="flex">
          <div className="w-full">
            <ItemCard item={item} t={t} locale={locale} headingLevel={headingLevel} />
          </div>
        </li>
      ))}
    </ul>
  );
}

export function Pagination({ page, totalPages, hrefFor, t }: { page: number; totalPages: number; hrefFor: (page: number) => string; t: T }) {
  if (totalPages <= 1) return null;
  const linkClass = "inline-flex min-h-11 items-center rounded-lg border border-border bg-surface px-4 text-sm font-semibold hover:bg-surface-muted";
  return (
    <nav aria-label={t("pagination.label")} className="mt-8 flex items-center justify-between gap-3">
      {page > 1 ? (
        <Link href={hrefFor(page - 1)} className={linkClass} rel="prev">
          {t("pagination.prev")}
        </Link>
      ) : (
        <span />
      )}
      <p className="text-sm text-muted" aria-current="page">
        {t("pagination.page", { page, total: totalPages })}
      </p>
      {page < totalPages ? (
        <Link href={hrefFor(page + 1)} className={linkClass} rel="next">
          {t("pagination.next")}
        </Link>
      ) : (
        <span />
      )}
    </nav>
  );
}
