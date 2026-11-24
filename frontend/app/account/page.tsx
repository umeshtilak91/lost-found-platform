"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { errorMessage, useAuth } from "@/features/auth/AuthProvider";
import { StatusBadge, TypeBadge } from "@/features/items/ItemCards";
import { RequireAuth } from "@/features/auth/RequireAuth";
import { Alert, Badge, Button, Card, Field, Input, PageHeader, Select } from "@/components/ui";
import { ListSkeleton } from "@/components/ui/Skeleton";
import { useToast } from "@/components/layout/Toaster";
import { api, fieldErrors } from "@/lib/api";
import { formatDate, formatDateTime } from "@/lib/format";
import { inr } from "@/lib/money";
import { useI18n } from "@/lib/i18n/client";
import { LOCALES, type Locale } from "@/lib/i18n/messages";
import type { Item, User } from "@/lib/types";

// Common countries first; the API validates any ISO country via libphonenumber.
const COUNTRIES = ["IN", "US", "GB", "AE", "SA", "SG", "AU", "CA", "DE", "FR", "NP", "BD", "LK", "PK", "MY", "ID", "PH", "ZA", "NG", "KE", "BR", "JP"];

function Profile() {
  const { t, locale, setLocale } = useI18n();
  const { user, refresh } = useAuth();
  const toast = useToast();
  const [name, setName] = useState(user?.name ?? "");
  const [phone, setPhone] = useState(user?.phone ?? "");
  const [country, setCountry] = useState("IN");
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<{ tone: "success" | "error"; text: string } | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const regionNames = new Intl.DisplayNames([locale === "hi" ? "hi-IN" : "en-IN"], { type: "region" });

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setSaving(true);
    setStatus(null);
    setErrors({});
    try {
      await api<{ user: User }>("/account/profile", {
        method: "PATCH",
        json: { name: name.trim(), phone: phone.trim() ? phone.trim() : null, phoneCountry: country, locale },
      });
      await refresh();
      setStatus({ tone: "success", text: t("account.saved") });
      toast(t("toast.profileSaved"));
    } catch (err) {
      setErrors(fieldErrors(err));
      setStatus({ tone: "error", text: errorMessage(err, t) });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card>
      <h2 className="mb-4 text-lg font-semibold">{t("account.profile")}</h2>
      <form onSubmit={save} className="flex flex-col gap-4">
        {status && <Alert tone={status.tone}>{status.text}</Alert>}
        <Field label={t("account.name")} hint={t("account.nameHint")} error={errors.name}>
          {(props) => <Input {...props} value={name} onChange={(e) => setName(e.target.value)} maxLength={100} autoComplete="name" />}
        </Field>
        <Field label={t("account.email")}>{(props) => <Input {...props} value={user?.email ?? ""} readOnly disabled />}</Field>
        <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
          <Field label={t("account.country")}>
            {(props) => (
              <Select {...props} value={country} onChange={(e) => setCountry(e.target.value)} autoComplete="country">
                {COUNTRIES.map((code) => (
                  <option key={code} value={code}>
                    {regionNames.of(code)}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label={t("account.phone")} hint={t("account.phoneHint")} error={errors.phone}>
            {(props) => <Input {...props} type="tel" autoComplete="tel" value={phone} onChange={(e) => setPhone(e.target.value)} maxLength={32} />}
          </Field>
        </div>
        <Field label={t("account.language")}>
          {(props) => (
            <Select {...props} value={locale} onChange={(e) => setLocale(e.target.value as Locale)}>
              {LOCALES.map((code) => (
                <option key={code} value={code} lang={code}>
                  {code === "en" ? "English" : "हिन्दी"}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Button type="submit" loading={saving} className="self-start">
          {t("account.save")}
        </Button>
      </form>
    </Card>
  );
}

function MyListings() {
  const { t, locale } = useI18n();
  const [items, setItems] = useState<Item[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api<{ items: Item[] }>("/me/items")
      .then((res) => setItems(res.items))
      .catch((err) => setError(errorMessage(err, t)));
  }, [t]);

  return (
    <Card>
      <h2 className="mb-4 text-lg font-semibold">{t("account.listings")}</h2>
      {error ? (
        <Alert tone="error">{error}</Alert>
      ) : !items ? (
        <ListSkeleton rows={3} label={t("common.loading")} />
      ) : items.length === 0 ? (
        <p className="text-sm text-muted">{t("account.noListings")}</p>
      ) : (
        <ul className="divide-y divide-border">
          {items.map((item) => (
            <li key={item.id} className="-mx-2 flex flex-wrap items-center justify-between gap-2 rounded-lg px-2 py-3 transition-colors hover:bg-surface-muted">
              <div className="min-w-0">
                <Link href={`/items/${item.id}`} className="font-medium text-primary underline-offset-4 hover:underline">
                  {item.title}
                </Link>
                <p className="text-xs text-muted">
                  {item.location} · {formatDate(item.date, locale)}
                </p>
              </div>
              <div className="flex flex-wrap gap-1.5">
                <TypeBadge type={item.type} t={t} />
                <StatusBadge status={item.status} t={t} />
                {item.closureReason && item.closureReason !== "returned_matched" && <Badge>{t(`closure.${item.closureReason}` as "closure.self_recovered")}</Badge>}
                {item.moderationState === "removed" && <Badge tone="lost">{t("moderation.removed")}</Badge>}
                {(item.pendingClaims ?? 0) > 0 && <Badge tone="warn">{t("account.pendingClaims", { count: item.pendingClaims! })}</Badge>}
              </div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

type ReturnRecord = {
  id: number;
  kind: "matched" | "self_recovered" | "external" | "legacy";
  role: "owner" | "finder";
  completedAt: string;
  corrected: boolean;
  lostItem: { id: number; title: string } | null;
  foundItem: { id: number; title: string } | null;
  conversationId: number | null;
  handoverAt: string | null;
  receiptConfirmedAt: string | null;
  reward: { status: "awaiting" | "confirmed" | "issue"; amountPaise: number | null } | null;
  payment: { orderId: string; amountPaise: number; status: string; paidAt: string | null } | null;
};

// Completed returns: kept for both participants after listings leave search.
function CompletedReturns() {
  const { t, locale } = useI18n();
  const [records, setRecords] = useState<ReturnRecord[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api<{ returns: ReturnRecord[] }>("/me/returns")
      .then((res) => setRecords(res.returns))
      .catch((err) => setError(errorMessage(err, t)));
  }, [t]);

  return (
    <Card>
      <h2 className="mb-4 text-lg font-semibold">{t("account.returns")}</h2>
      {error ? (
        <Alert tone="error">{error}</Alert>
      ) : !records ? (
        <ListSkeleton rows={2} label={t("common.loading")} />
      ) : records.length === 0 ? (
        <p className="text-sm text-muted">{t("account.noReturns")}</p>
      ) : (
        <ul className="divide-y divide-border" data-testid="completed-returns">
          {records.map((r) => {
            const listings = [r.lostItem, r.foundItem].filter(Boolean) as { id: number; title: string }[];
            return (
              <li key={r.id} className="flex flex-col gap-1.5 py-3">
                <div className="flex flex-wrap items-center gap-2">
                  {listings.map((l) => (
                    <Link key={l.id} href={`/items/${l.id}`} className="font-medium text-primary underline-offset-4 hover:underline">
                      {l.title}
                    </Link>
                  ))}
                  <Badge tone={r.corrected ? "warn" : "success"}>{r.corrected ? t("account.return.corrected") : t(`account.return.kind.${r.kind}`)}</Badge>
                  {r.kind === "matched" && <Badge>{r.role === "owner" ? t("account.return.asOwner") : t("account.return.asFinder")}</Badge>}
                </div>
                <p className="text-xs text-muted">
                  {t("account.return.completed", { date: formatDateTime(r.completedAt, locale) })}
                  {r.handoverAt && ` · ${t("account.return.handover", { date: formatDateTime(r.handoverAt, locale) })}`}
                </p>
                {r.reward && (
                  <p className="text-xs">
                    {t("reward.sectionTitle")}: {r.reward.amountPaise ? `${inr(r.reward.amountPaise, locale)} · ` : ""}
                    {t(`reward.status.${r.reward.status}`)}
                  </p>
                )}
                {r.payment && (
                  <p className="text-xs text-muted">
                    {t("account.return.receipt", { amount: inr(r.payment.amountPaise, locale), order: r.payment.orderId, status: t(`payment.status.${r.payment.status}` as "payment.status.paid") })}
                  </p>
                )}
                {r.conversationId && (
                  <Link href={`/inbox/${r.conversationId}`} className="text-xs font-semibold text-primary underline-offset-4 hover:underline">
                    {t("account.return.conversation")}
                  </Link>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}

function DataControls() {
  const { t } = useI18n();
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <Card>
      <h2 className="mb-2 text-lg font-semibold">{t("account.data")}</h2>
      <p className="text-sm text-muted">{t("account.exportHint")}</p>
      <a
        href="/api/account/export"
        download
        className="mt-3 inline-flex min-h-11 items-center rounded-lg border border-border px-4 text-sm font-semibold hover:bg-surface-muted"
      >
        {t("account.export")}
      </a>
      <div className="mt-6 border-t border-border pt-6">
        <h3 className="font-semibold text-lost">{t("account.delete")}</h3>
        <p className="mt-1 text-sm text-muted">{t("account.deleteHint")}</p>
        <form
          className="mt-3 flex flex-col gap-3 sm:flex-row sm:items-end"
          onSubmit={async (event) => {
            event.preventDefault();
            setBusy(true);
            setError(null);
            try {
              await api("/account", { method: "DELETE", json: { confirm } });
              // Full reload on purpose: drops every piece of client state after sign-out/deletion.
              // eslint-disable-next-line @next/next/no-location-assign-relative-destination
              window.location.assign("/");
            } catch (err) {
              setError(errorMessage(err, t));
              setBusy(false);
            }
          }}
        >
          <div className="flex-1">
            <Field label={t("account.deleteConfirmLabel")} error={error ?? undefined}>
              {(props) => <Input {...props} value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="off" />}
            </Field>
          </div>
          <Button type="submit" variant="danger" loading={busy} disabled={confirm !== "DELETE"} disabledReason={t("disabled.needConfirm")}>
            {t("account.deleteButton")}
          </Button>
        </form>
      </div>
    </Card>
  );
}

export default function AccountPage() {
  const { t } = useI18n();
  useEffect(() => {
    document.title = `${t("account.title")} · ${t("app.name")}`;
  }, [t]);
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6">
      <PageHeader title={t("account.title")} />
      <RequireAuth message="account.signInRequired">
        <div className="flex flex-col gap-6">
          <Profile />
          <MyListings />
          <CompletedReturns />
          <DataControls />
        </div>
      </RequireAuth>
    </div>
  );
}
