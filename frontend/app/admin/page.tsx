"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { errorMessage, useAuth } from "@/features/auth/AuthProvider";
import { RequireAuth } from "@/features/auth/RequireAuth";
import { Alert, Card, PageHeader, Select } from "@/components/ui";
import { PanelSkeleton } from "@/components/ui/Skeleton";
import { VisitorsChart, type DailyPoint } from "@/features/admin/VisitorsChart";
import { api } from "@/lib/api";
import { formatNumber } from "@/lib/format";
import { useI18n } from "@/lib/i18n/client";

type Analytics = {
  days: number;
  totals: { visitorsToday: number; viewsToday: number; visitors7d: number; views7d: number; visitorsPeriod: number; viewsPeriod: number };
  daily: DailyPoint[];
  topPages: { path: string; views: number; visitors: number }[];
  topReferrers: { host: string; visitors: number }[];
};

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <Card className="flex flex-col gap-1 p-4 sm:p-5">
      <p className="text-sm text-muted">{label}</p>
      <p className="text-3xl font-bold tabular-nums">{value}</p>
      {sub && <p className="text-xs text-muted">{sub}</p>}
    </Card>
  );
}

// Ranked list with a proportional bar; text stays in ink colors, the bar carries magnitude.
function RankedList({ rows, labelHeader, valueHeader }: { rows: { label: React.ReactNode; key: string; value: number }[]; labelHeader: string; valueHeader: string }) {
  const { locale } = useI18n();
  const max = Math.max(...rows.map((r) => r.value), 1);
  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="text-left text-xs text-muted">
          <th scope="col" className="pb-2 font-medium">{labelHeader}</th>
          <th scope="col" className="pb-2 text-right font-medium">{valueHeader}</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.key} className="border-t border-border">
            <td className="py-2 pr-3">
              <div className="truncate">{row.label}</div>
              <div className="mt-1 h-1.5 rounded-full bg-surface-muted">
                <div className="h-1.5 rounded-full bg-chart-1" style={{ width: `${(row.value / max) * 100}%` }} />
              </div>
            </td>
            <td className="py-2 text-right align-top tabular-nums">{formatNumber(row.value, locale)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Dashboard() {
  const { t, locale } = useI18n();
  const { user } = useAuth();
  const [days, setDays] = useState(30);
  const [data, setData] = useState<Analytics | null>(null);
  const [error, setError] = useState<string | null>(null);
  const allowed = user && (user.role === "admin" || user.role === "moderator");

  const load = useCallback(
    (range: number) =>
      api<Analytics>(`/admin/analytics?days=${range}`).then(
        (res) => setData(res),
        (err) => setError(errorMessage(err, t))
      ),
    [t]
  );

  useEffect(() => {
    document.title = `${t("admin.title")} · ${t("app.name")}`;
    if (allowed) load(days);
  }, [allowed, days, load, t]);

  if (!allowed) return <Alert tone="error">{t("admin.forbidden")}</Alert>;
  if (error) return <Alert tone="error">{error}</Alert>;
  if (!data) return <PanelSkeleton label={t("common.loading")} />;

  const n = (value: number) => formatNumber(value, locale);
  const empty = data.totals.viewsPeriod === 0;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <h2 className="text-xl font-semibold">{t("admin.visitors")}</h2>
        <label className="flex items-center gap-2 text-sm">
          <span>{t("admin.range")}</span>
          <Select value={days} onChange={(e) => setDays(Number(e.target.value))} className="w-auto">
            {[7, 30, 90].map((d) => (
              <option key={d} value={d}>
                {t("admin.range.days", { days: d })}
              </option>
            ))}
          </Select>
        </label>
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label={t("admin.visitorsToday")} value={n(data.totals.visitorsToday)} sub={t("admin.viewsToday", { count: n(data.totals.viewsToday) })} />
        <Stat label={t("admin.visitors7d")} value={n(data.totals.visitors7d)} />
        <Stat label={t("admin.visitorsPeriod", { days: data.days })} value={n(data.totals.visitorsPeriod)} />
        <Stat label={t("admin.viewsPeriod", { days: data.days })} value={n(data.totals.viewsPeriod)} />
      </div>

      <Card>
        <h3 className="mb-3 font-semibold">{t("admin.dailyVisitors")}</h3>
        {empty ? <p className="text-sm text-muted">{t("admin.noData")}</p> : <VisitorsChart data={data.daily} />}
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <h3 className="mb-3 font-semibold">{t("admin.topPages")}</h3>
          {data.topPages.length === 0 ? (
            <p className="text-sm text-muted">{t("admin.noData")}</p>
          ) : (
            <RankedList
              labelHeader={t("admin.page")}
              valueHeader={t("admin.viewsCol")}
              rows={data.topPages.map((p) => ({
                key: p.path,
                value: p.views,
                label: p.path.includes(":") ? (
                  <code>{p.path}</code>
                ) : (
                  <Link href={p.path} className="text-primary underline-offset-4 hover:underline">
                    <code>{p.path}</code>
                  </Link>
                ),
              }))}
            />
          )}
        </Card>
        <Card>
          <h3 className="mb-3 font-semibold">{t("admin.topReferrers")}</h3>
          {data.topReferrers.length === 0 ? (
            <p className="text-sm text-muted">{t("admin.noReferrers")}</p>
          ) : (
            <RankedList
              labelHeader={t("admin.source")}
              valueHeader={t("admin.visitorsCol")}
              rows={data.topReferrers.map((r) => ({ key: r.host, value: r.visitors, label: r.host }))}
            />
          )}
        </Card>
      </div>

      <p className="text-xs text-muted">{t("admin.note")}</p>
      <Link href="/moderation" className="inline-flex min-h-11 items-center self-start text-sm font-semibold text-primary">
        {t("admin.moderationLink")} →
      </Link>
    </div>
  );
}

export default function AdminPage() {
  const { t } = useI18n();
  return (
    <div>
      <PageHeader title={t("admin.title")} />
      <RequireAuth>
        <Dashboard />
      </RequireAuth>
    </div>
  );
}
