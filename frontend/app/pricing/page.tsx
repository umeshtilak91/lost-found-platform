import type { Metadata } from "next";
import { Alert, LinkButton } from "@/components/ui";
import { serverApi } from "@/lib/server-api";
import { getT } from "@/lib/i18n/server";
import { FALLBACK_CONNECTION_FEE_PAISE, inr } from "@/lib/money";

export const metadata: Metadata = { title: "Pricing & rewards" };

type Pricing = { connectionFeePaise: number; pricingVersion: string; categories: { category: string; rewardPaise: number }[] };

// Pricing, FAQ and refund rules. Amounts come from the API's single pricing table.
export default async function PricingPage() {
  const { t, locale } = await getT();
  const result = await serverApi<Pricing>("/pricing", { forwardCookies: false });
  const fee = result.ok ? inr(result.data.connectionFeePaise, locale) : inr(FALLBACK_CONNECTION_FEE_PAISE, locale);

  return (
    <article className="mx-auto flex max-w-3xl flex-col gap-6 leading-relaxed">
      <h1 className="text-3xl font-bold">{t("reward.howPricingWorks")}</h1>
      <ul className="list-disc pl-6">
        <li>Posting a lost or found item is free. Ownership verification (answering the poster&apos;s question) is free.</li>
        <li>
          When a match is accepted, the <strong>owner pays a {fee} connection fee</strong> on this website. That unlocks private chat between the owner and
          the finder for that match only.
        </li>
        <li>
          The <strong>finder reward</strong> depends on the category and is paid <strong>directly by the owner to the finder</strong> at handover (UPI, cash,
          or any method you agree). The platform does not collect, hold or guarantee rewards.
        </li>
        <li>Paying the connection fee never shares anyone&apos;s phone number. Each person decides, per chat, whether to share theirs.</li>
        <li>The finder records whether they received the reward. That record is the finder&apos;s own confirmation, not a verified payment.</li>
      </ul>

      <section aria-labelledby="table-title">
        <h2 id="table-title" className="mb-3 text-xl font-semibold">
          {t("reward.panelTitle")}
        </h2>
        {result.ok ? (
          <table className="w-full overflow-hidden rounded-xl border border-border text-sm">
            <thead className="bg-surface-muted text-left">
              <tr>
                <th scope="col" className="px-3 py-2">{t("item.category")}</th>
                <th scope="col" className="px-3 py-2 text-right">{t("reward.finderReward")}</th>
                <th scope="col" className="px-3 py-2 text-right">{t("reward.connectionFee")}</th>
              </tr>
            </thead>
            <tbody>
              {result.data.categories.map((row) => (
                <tr key={row.category} className="border-t border-border">
                  <td className="px-3 py-2">{t(`category.${row.category}` as "category.other")}</td>
                  <td className="px-3 py-2 text-right font-semibold tabular-nums">{inr(row.rewardPaise, locale)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{fee}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <Alert tone="error">{t("common.error")}</Alert>
        )}
        {result.ok && <p className="mt-2 text-xs text-muted">Pricing version {result.data.pricingVersion}. Accepted agreements keep the amounts shown when they were accepted.</p>}
      </section>

      <section aria-labelledby="faq-title">
        <h2 id="faq-title" className="mb-3 text-xl font-semibold">
          FAQ
        </h2>
        <dl className="flex flex-col gap-4">
          <div>
            <dt className="font-semibold">Who pays the {fee}?</dt>
            <dd className="text-muted">Always the owner of the item, once the match is accepted, whether the owner or the finder posted first.</dd>
          </div>
          <div>
            <dt className="font-semibold">What does the {fee} buy?</dt>
            <dd className="text-muted">Private chat with the matched person for that item, and the option for either of you to share a phone number.</dd>
          </div>
          <div>
            <dt className="font-semibold">Can the category change after I agree?</dt>
            <dd className="text-muted">
              If the category or pricing changes before a match is accepted, you&apos;ll be asked to accept the new amount. Accepted agreements keep their
              recorded amount.
            </dd>
          </div>
          <div>
            <dt className="font-semibold">What if the reward isn&apos;t paid?</dt>
            <dd className="text-muted">
              The finder can report a reward payment issue from the chat. Our team reviews it. The item can still be marked returned; both facts are kept.
            </dd>
          </div>
        </dl>
      </section>

      <section id="refunds" aria-labelledby="refund-title">
        <h2 id="refund-title" className="mb-3 text-xl font-semibold">
          Connection-fee refunds
        </h2>
        <Alert tone="warn">Proposed rules pending owner review. Every request is reviewed by a person.</Alert>
        <ul className="mt-3 list-disc pl-6">
          <li>Request from the chat within 7 days of paying, before confirming you received the item.</li>
          <li>Usually approved if the finder sends no reply within 72 hours of the chat unlocking, or if it&apos;s clearly not your item.</li>
          <li>Not available after you confirm the item was returned, or for disputes about the reward (those are handled separately).</li>
          <li>Approved refunds go back to the original payment method and close the paid chat. You can connect again later if needed.</li>
        </ul>
      </section>

      <LinkButton href="/report" className="self-start">
        {t("nav.report")}
      </LinkButton>
    </article>
  );
}
