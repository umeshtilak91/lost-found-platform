"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { errorMessage, useAuth } from "@/features/auth/AuthProvider";
import { RequireAuth } from "@/features/auth/RequireAuth";
import {
  Alert,
  Badge,
  Button,
  Card,
  EmptyState,
  Field,
  PageHeader,
  Textarea,
} from "@/components/ui";
import { api } from "@/lib/api";
import { ListSkeleton } from "@/components/ui/Skeleton";
import { PendingListings, SupportQueue } from "@/features/moderation/SupportQueue";
import { useToast } from "@/components/layout/Toaster";
import { formatRelative } from "@/lib/format";
import { useI18n } from "@/lib/i18n/client";
import type { MessageKey } from "@/lib/i18n/messages";
import type { Item } from "@/lib/types";

type Entry = {
  item: Item;
  deleted: boolean;
  reports: {
    id: number;
    reason: string;
    details: string | null;
    reporter: string;
    createdAt: string;
  }[];
};
type Action = {
  id: number;
  action: string;
  itemId: number | null;
  reason: string | null;
  moderator: string | null;
  createdAt: string;
};

function QueueEntry({ entry, onDone }: { entry: Entry; onDone: () => void }) {
  const { t, locale } = useI18n();
  const toast = useToast();
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const removed = entry.item.moderationState === "removed";

  async function act(key: string, path: string) {
    setBusy(key);
    setError(null);
    try {
      await api(path, { method: "POST", json: { reason } });
      toast(key === "remove" ? t("toast.removed") : t("toast.dismissed"));
      onDone();
    } catch (err) {
      setError(errorMessage(err, t));
      setBusy(null);
    }
  }

  return (
    <article aria-label={entry.item.title}>
      <Card>
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <Link
              href={`/items/${entry.item.id}`}
              className="font-semibold text-primary underline-offset-4 hover:underline"
            >
              {entry.item.title}
            </Link>
            <p className="text-xs text-muted">
              {entry.item.location} ·{" "}
              {t("item.postedBy", { name: entry.item.reporter.displayName })}
            </p>
          </div>
          <div className="flex gap-1.5">
            {removed && <Badge tone="lost">{t("moderation.removed")}</Badge>}
            <Badge tone="warn">
              {t("moderation.reports", { count: entry.reports.length })}
            </Badge>
          </div>
        </div>
        <ul className="mt-3 flex flex-col gap-2">
          {entry.reports.map((report) => (
            <li
              key={report.id}
              className="rounded-lg bg-surface-muted p-3 text-sm"
            >
              <p className="font-medium">
                {t(`actions.report.reason.${report.reason}` as MessageKey)}
              </p>
              {report.details && <p className="mt-1">{report.details}</p>}
              <p className="mt-1 text-xs text-muted">
                {report.reporter} · {formatRelative(report.createdAt, locale)}
              </p>
            </li>
          ))}
        </ul>
        <div className="mt-4 flex flex-col gap-3">
          {error && <Alert tone="error">{error}</Alert>}
          <Field label={t("moderation.reason")}>
            {(props) => (
              <Textarea
                {...props}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                rows={2}
                maxLength={500}
              />
            )}
          </Field>
          <div className="flex flex-wrap gap-2">
            {!removed && (
              <Button
                type="button"
                variant="danger"
                disabled={reason.trim().length < 3}
                disabledReason={t("disabled.needReason")}
                loading={busy === "remove"}
                onClick={() =>
                  act("remove", `/moderation/items/${entry.item.id}/remove`)
                }
              >
                {t("moderation.remove")}
              </Button>
            )}
            {entry.reports.map((report) => (
              <Button
                key={report.id}
                type="button"
                variant="secondary"
                disabled={reason.trim().length < 3}
                disabledReason={t("disabled.needReason")}
                loading={busy === `d${report.id}`}
                onClick={() =>
                  act(
                    `d${report.id}`,
                    `/moderation/reports/${report.id}/dismiss`,
                  )
                }
              >
                {t("moderation.dismiss")}
                {entry.reports.length > 1 ? ` #${report.id}` : ""}
              </Button>
            ))}
          </div>
        </div>
      </Card>
    </article>
  );
}

function Queue() {
  const { t, locale } = useI18n();
  const { user } = useAuth();
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [actions, setActions] = useState<Action[]>([]);
  const [error, setError] = useState<string | null>(null);
  const allowed = user && (user.role === "moderator" || user.role === "admin");

  const load = useCallback(
    () =>
      Promise.all([
        api<{ entries: Entry[] }>("/moderation/queue"),
        api<{ actions: Action[] }>("/moderation/actions"),
      ]).then(
        ([queue, audit]) => {
          setEntries(queue.entries);
          setActions(audit.actions);
        },
        (err) => setError(errorMessage(err, t)),
      ),
    [t],
  );

  useEffect(() => {
    document.title = `${t("moderation.title")} · ${t("app.name")}`;
    if (allowed) load();
  }, [allowed, load, t]);

  if (!allowed) return <Alert tone="error">{t("moderation.forbidden")}</Alert>;
  if (error) return <Alert tone="error">{error}</Alert>;
  if (!entries) return <ListSkeleton rows={3} label={t("common.loading")} />;

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
      <div className="flex flex-col gap-4">
        {entries.length === 0 ? (
          <EmptyState title={t("moderation.empty")} />
        ) : (
          entries.map((entry) => (
            <QueueEntry key={entry.item.id} entry={entry} onDone={load} />
          ))
        )}
      </div>
      <Card>
        <h2 className="mb-3 font-semibold">{t("moderation.audit")}</h2>
        <ul className="flex flex-col gap-2 text-sm">
          {actions.slice(0, 30).map((a) => (
            <li key={a.id}>
              <span className="font-medium">{a.action.replace("_", " ")}</span>{" "}
              #{a.itemId} — {a.reason}
              <span className="block text-xs text-muted">
                {a.moderator} · {formatRelative(a.createdAt, locale)}
              </span>
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}

function ModeratorOnly({ children }: { children: React.ReactNode }) {
  const { user } = useAuth();
  if (!user || (user.role !== "moderator" && user.role !== "admin"))
    return null;
  return <div className="flex flex-col gap-10">{children}</div>;
}

export default function ModerationPage() {
  const { t } = useI18n();
  return (
    <div>
      <PageHeader title={t("moderation.title")} />
      <RequireAuth>
        <div className="flex flex-col gap-10">
          <Queue />
          <ModeratorOnly>
            <SupportQueue />
            <PendingListings />
          </ModeratorOnly>
        </div>
      </RequireAuth>
    </div>
  );
}
