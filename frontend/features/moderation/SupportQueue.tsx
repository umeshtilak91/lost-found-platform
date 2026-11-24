"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { errorMessage } from "@/features/auth/AuthProvider";
import { useToast } from "@/components/layout/Toaster";
import { Alert, Badge, Button, Card, Field, Textarea } from "@/components/ui";
import { api } from "@/lib/api";
import { formatRelative } from "@/lib/format";
import { inr } from "@/lib/money";
import { useI18n } from "@/lib/i18n/client";
import type { Item } from "@/lib/types";

type SupportRequest = {
  id: number;
  kind: "refund" | "reward_issue" | "return_issue" | "return_correction";
  message: string;
  requester: string;
  claimId: number | null;
  itemId: number | null;
  itemTitle: string | null;
  rewardPaise: number | null;
  rewardStatus: string | null;
  returnConfirmed: boolean;
  payment: { status: string; amountPaise: number; paidAt: string | null } | null;
  finderMessages: number;
  createdAt: string;
};

function RequestCard({ request, onDone }: { request: SupportRequest; onDone: () => void }) {
  const { t, locale } = useI18n();
  const toast = useToast();
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function resolve(action: "approve_refund" | "reject" | "resolve" | "reopen") {
    setBusy(action);
    setError(null);
    try {
      await api(`/moderation/support/${request.id}/resolve`, { method: "POST", json: { action, note } });
      toast(action === "approve_refund" ? t("support.approveRefund") : action === "reject" ? t("support.reject") : action === "reopen" ? t("support.reopen") : t("support.resolve"));
      onDone();
    } catch (err) {
      setError(errorMessage(err, t));
      setBusy(null);
    }
  }

  return (
    <article aria-label={`${request.kind} ${request.id}`}>
      <Card>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Badge tone={request.kind === "refund" ? "warn" : "lost"}>{t(`support.kind.${request.kind}`)}</Badge>
          <span className="text-xs text-muted">
            {request.requester} · {formatRelative(request.createdAt, locale)}
          </span>
        </div>
        {request.itemId && (
          <Link href={`/items/${request.itemId}`} className="mt-2 block font-semibold text-primary underline-offset-4 hover:underline">
            {request.itemTitle}
          </Link>
        )}
        <p className="mt-2 text-sm">{request.message}</p>
        <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
          {request.payment && (
            <li>
              {inr(request.payment.amountPaise, locale)} · {request.payment.status}
            </li>
          )}
          {request.rewardPaise && <li>{t("reward.finder", { amount: inr(request.rewardPaise, locale) })}</li>}
          {request.rewardStatus && <li>{t(`reward.status.${request.rewardStatus}` as "reward.status.awaiting")}</li>}
          <li>{request.returnConfirmed ? t("return.confirmed", { date: "" }).trim() : t("return.notYet")}</li>
          <li>finder messages: {request.finderMessages}</li>
        </ul>
        {error && (
          <Alert tone="error" className="mt-3">
            {error}
          </Alert>
        )}
        <div className="mt-3 flex flex-col gap-2">
          <Field label={t("support.note")}>{(props) => <Textarea {...props} value={note} onChange={(e) => setNote(e.target.value)} rows={2} maxLength={500} />}</Field>
          <div className="flex flex-wrap gap-2">
            {request.kind === "refund" && (
              <Button type="button" variant="danger" loading={busy === "approve_refund"} disabled={note.trim().length < 3} disabledReason={t("disabled.needReason")} onClick={() => resolve("approve_refund")}>
                {t("support.approveRefund")}
              </Button>
            )}
            {request.kind === "return_correction" && (
              <Button type="button" variant="danger" loading={busy === "reopen"} disabled={note.trim().length < 3} disabledReason={t("disabled.needReason")} onClick={() => resolve("reopen")}>
                {t("support.reopen")}
              </Button>
            )}
            {request.kind === "refund" || request.kind === "return_correction" ? (
              <Button type="button" variant="secondary" loading={busy === "reject"} disabled={note.trim().length < 3} disabledReason={t("disabled.needReason")} onClick={() => resolve("reject")}>
                {t("support.reject")}
              </Button>
            ) : (
              <Button type="button" variant="secondary" loading={busy === "resolve"} disabled={note.trim().length < 3} disabledReason={t("disabled.needReason")} onClick={() => resolve("resolve")}>
                {t("support.resolve")}
              </Button>
            )}
          </div>
        </div>
      </Card>
    </article>
  );
}

export function SupportQueue() {
  const { t } = useI18n();
  const [requests, setRequests] = useState<SupportRequest[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(
    () =>
      api<{ requests: SupportRequest[] }>("/moderation/support").then(
        (res) => setRequests(res.requests),
        (err) => setError(errorMessage(err, t))
      ),
    [t]
  );
  useEffect(() => {
    load();
  }, [load]);
  return (
    <section aria-labelledby="support-title" className="flex flex-col gap-3">
      <h2 id="support-title" className="text-xl font-semibold">
        {t("support.title")}
      </h2>
      {error && <Alert tone="error">{error}</Alert>}
      {requests && requests.length === 0 && <p className="text-sm text-muted">{t("support.empty")}</p>}
      {requests?.map((request) => <RequestCard key={request.id} request={request} onDone={load} />)}
    </section>
  );
}

export function PendingListings() {
  const { t } = useI18n();
  const toast = useToast();
  const [items, setItems] = useState<Item[] | null>(null);
  const [busy, setBusy] = useState<number | null>(null);
  const load = useCallback(() => api<{ items: Item[] }>("/moderation/pending").then((res) => setItems(res.items), () => setItems([])), []);
  useEffect(() => {
    load();
  }, [load]);
  return (
    <section aria-labelledby="pending-title" className="flex flex-col gap-3">
      <h2 id="pending-title" className="text-xl font-semibold">
        {t("moderation.pendingTitle")}
      </h2>
      {items && items.length === 0 && <p className="text-sm text-muted">{t("moderation.pendingEmpty")}</p>}
      {items?.map((item) => (
        <Card key={item.id}>
          <Link href={`/items/${item.id}`} className="font-semibold text-primary underline-offset-4 hover:underline">
            {item.title}
          </Link>
          <p className="mt-1 whitespace-pre-line text-sm">{item.description || "—"}</p>
          <p className="mt-1 text-xs text-muted">{item.location}</p>
          <Button
            type="button"
            className="mt-3"
            loading={busy === item.id}
            onClick={async () => {
              setBusy(item.id);
              await api(`/moderation/items/${item.id}/restore`, { method: "POST", json: { reason: "Reviewed: no contact details" } }).catch(() => {});
              toast(t("toast.restored"));
              setBusy(null);
              load();
            }}
          >
            {t("moderation.approve")}
          </Button>
        </Card>
      ))}
    </section>
  );
}
