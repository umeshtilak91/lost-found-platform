"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import clsx from "clsx";
import { errorMessage, useAuth } from "@/features/auth/AuthProvider";
import { RequireAuth } from "@/features/auth/RequireAuth";
import { Alert, Button, EmptyState, PageHeader } from "@/components/ui";
import { ListSkeleton } from "@/components/ui/Skeleton";
import { useToast } from "@/components/layout/Toaster";
import { api } from "@/lib/api";
import { formatRelative } from "@/lib/format";
import { useI18n } from "@/lib/i18n/client";
import type { MessageKey } from "@/lib/i18n/messages";

type Notification = {
  id: number;
  type: string;
  itemId: number | null;
  itemTitle: string | null;
  data: { conversationId?: number; matchItemId?: number; status?: string; closureReason?: string; reason?: string; claimId?: number };
  read: boolean;
  createdAt: string;
};

function hrefFor(n: Notification) {
  if (n.type === "message" && n.data.conversationId) return `/inbox/${n.data.conversationId}`;
  // Return steps open the conversation, where the confirmation panel lives.
  if (["handover_reported", "return_reminder", "return_confirmed", "connection_unlocked"].includes(n.type) && n.data.conversationId) return `/inbox/${n.data.conversationId}`;
  if (n.type === "match" && n.data.matchItemId) return `/items/${n.data.matchItemId}`;
  return n.itemId ? `/items/${n.itemId}` : null;
}

function NotificationList() {
  const { t, locale } = useI18n();
  const { refreshCounts } = useAuth();
  const toast = useToast();
  const [items, setItems] = useState<Notification[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    () =>
      api<{ notifications: Notification[] }>("/notifications").then(
        (res) => setItems(res.notifications),
        (err) => setError(errorMessage(err, t))
      ),
    [t]
  );
  useEffect(() => {
    document.title = `${t("notifications.title")} · ${t("app.name")}`;
    load();
  }, [load, t]);

  async function markAll() {
    await api("/notifications/read", { method: "POST", json: {} }).catch(() => {});
    await load();
    refreshCounts();
    toast(t("toast.allRead"), "info");
  }

  if (error) return <Alert tone="error">{error}</Alert>;
  if (!items) return <ListSkeleton label={t("common.loading")} />;
  if (items.length === 0) return <EmptyState title={t("notifications.empty")} />;

  return (
    <>
      {items.some((n) => !n.read) && (
        <div className="mb-3 flex justify-end">
          <Button type="button" variant="secondary" onClick={markAll}>
            {t("notifications.markAll")}
          </Button>
        </div>
      )}
      <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-surface">
        {items.map((n) => {
          const title = n.itemTitle ?? t("notifications.unavailable");
          const status = n.data.status ? t(`claim.status.${n.data.status}` as MessageKey).toLowerCase() : "";
          const text =
            n.type === "item_status" && n.data.closureReason
              ? t(`notifications.item_status.${n.data.closureReason}` as MessageKey, { title })
              : n.type === "claim_update" && n.data.reason
                ? t(`notifications.claim_closed.${n.data.reason}` as MessageKey, { title })
                : t(`notifications.${n.type}` as MessageKey, { title, status });
          const href = hrefFor(n);
          const content = (
            <div className="flex items-start justify-between gap-3">
              <span className={clsx("text-sm", !n.read && "font-semibold")}>
                {!n.read && <span className="mr-2 inline-block size-2 rounded-full bg-primary" aria-hidden />}
                {text}
              </span>
              <span className="shrink-0 text-xs text-muted">{formatRelative(n.createdAt, locale)}</span>
            </div>
          );
          return (
            <li key={n.id}>
              {href ? (
                <Link
                  href={href}
                  className="block min-h-14 px-4 py-3 transition-colors hover:bg-surface-muted"
                  onClick={() => api("/notifications/read", { method: "POST", json: { ids: [n.id] } }).then(refreshCounts).catch(() => {})}
                >
                  {content}
                </Link>
              ) : (
                <div className="px-4 py-3">{content}</div>
              )}
            </li>
          );
        })}
      </ul>
    </>
  );
}

export default function NotificationsPage() {
  const { t } = useI18n();
  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader title={t("notifications.title")} />
      <RequireAuth>
        <NotificationList />
      </RequireAuth>
    </div>
  );
}
