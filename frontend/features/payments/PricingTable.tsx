import { BadgeIndianRupee, Handshake } from "lucide-react";
import { inr } from "@/lib/money";
import type { Locale, MessageKey } from "@/lib/i18n/messages";
import type { Item } from "@/lib/types";

type T = (key: MessageKey, vars?: Record<string, string | number>) => string;

// Compact label for item cards. Lost listings with an owner commitment show
// "Finder reward"; others show "Category reward" (no implied commitment).
export function RewardTag({ reward, t, locale, compact = false }: { reward: Item["reward"]; t: T; locale: Locale; compact?: boolean }) {
  if (!reward) return null;
  const amount = inr(reward.amountPaise, locale);
  const committed = reward.kind === "finder_reward";
  return (
    <p className="flex flex-wrap items-center gap-x-1.5 text-sm">
      <BadgeIndianRupee className="size-4 shrink-0 text-found" aria-hidden />
      <span className="font-semibold text-found">{committed ? t("reward.finder", { amount }) : t("reward.category", { amount })}</span>
      {!compact && committed && <span className="text-xs text-muted">· {t("reward.paidByOwner")}</span>}
    </p>
  );
}

// Detail-page panel near the claim/contact action.
export function RewardPanel({ rewardPaise, feePaise, t, locale }: { rewardPaise: number; feePaise: number; t: T; locale: Locale }) {
  return (
    <section aria-labelledby="pricing-title" className="rounded-xl border border-found/40 bg-found-bg/40 p-4">
      <h2 id="pricing-title" className="sr-only">
        {t("reward.panelTitle")}
      </h2>
      <dl className="grid gap-3 sm:grid-cols-2">
        <div>
          <dt className="flex items-center gap-1.5 text-sm font-semibold">
            <Handshake className="size-4 text-found" aria-hidden />
            {t("reward.finderReward")}
          </dt>
          <dd className="mt-1 text-sm">
            <span className="block text-lg font-bold">{inr(rewardPaise, locale)}</span>
            <span className="text-muted">{t("reward.detail.rewardBody", { amount: inr(rewardPaise, locale) })}</span>
          </dd>
        </div>
        <div>
          <dt className="flex items-center gap-1.5 text-sm font-semibold">
            <BadgeIndianRupee className="size-4 text-primary" aria-hidden />
            {t("reward.connectionFeeShort")}
          </dt>
          <dd className="mt-1 text-sm">
            <span className="block text-lg font-bold">{inr(feePaise, locale)}</span>
            <span className="text-muted">{t("reward.detail.feeBody", { fee: inr(feePaise, locale) })}</span>
          </dd>
        </div>
      </dl>
      <p className="mt-3 text-xs text-muted">{t("reward.detail.free")}</p>
    </section>
  );
}
