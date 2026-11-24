"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { formatDate, formatNumber } from "@/lib/format";
import { useI18n } from "@/lib/i18n/client";

export type DailyPoint = { day: string; visitors: number; views: number };

// Single-series column chart of daily unique visitors.
// - one hue (validated --chart-1 for light and dark), no legend: the title names the series
// - columns anchored to the baseline with 4px rounded tops and 2px gaps
// - recessive grid, few axis labels, hover/focus tooltip with a full-height hit target
// - a table view of the same data for screen readers and exact values
const HEIGHT = 200;
const PAD = { top: 12, right: 8, bottom: 24, left: 36 };

function niceMax(value: number) {
  if (value <= 4) return 4;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  for (const step of [1, 2, 2.5, 5, 10]) {
    if (step * magnitude >= value) return step * magnitude;
  }
  return 10 * magnitude;
}

function topRoundedBar(x: number, y: number, w: number, h: number, r: number) {
  const radius = Math.min(r, w / 2, h);
  if (h <= 0) return "";
  return `M${x},${y + h} V${y + radius} Q${x},${y} ${x + radius},${y} H${x + w - radius} Q${x + w},${y} ${x + w},${y + radius} V${y + h} Z`;
}

export function VisitorsChart({ data }: { data: DailyPoint[] }) {
  const { t, locale } = useI18n();
  const [active, setActive] = useState<number | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  // Draw at the container's real pixel width so text stays 11px on phones.
  const [width, setWidth] = useState(720);
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => setWidth(Math.max(280, Math.round(entry.contentRect.width))));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const { max, ticks, peak } = useMemo(() => {
    const top = Math.max(...data.map((d) => d.visitors), 0);
    const m = niceMax(top);
    const peakPoint = data.reduce((best, d) => (d.visitors > best.visitors ? d : best), data[0] ?? { day: "", visitors: 0, views: 0 });
    return { max: m, ticks: [0, m / 2, m], peak: peakPoint };
  }, [data]);

  const plotW = width - PAD.left - PAD.right;
  const plotH = HEIGHT - PAD.top - PAD.bottom;
  const slot = plotW / Math.max(data.length, 1);
  const gap = 2;
  const barW = Math.max(1, slot - gap);
  const y = (v: number) => PAD.top + plotH - (v / max) * plotH;
  const labelEvery = Math.ceil(data.length / Math.max(2, Math.floor(plotW / 70)));
  const short = (day: string) => formatDate(day, locale).replace(/\s?\d{4}$/, "");

  const activePoint = active !== null ? data[active] : null;
  const tooltipLeft = active !== null ? ((PAD.left + active * slot + slot / 2) / width) * 100 : 0;

  return (
    <figure className="flex flex-col gap-3">
      <figcaption className="sr-only">
        {t("admin.chartSummary", { days: data.length, peak: peak.visitors, date: peak.day ? formatDate(peak.day, locale) : "—" })}
      </figcaption>
      <div ref={wrapRef} className="relative" onMouseLeave={() => setActive(null)}>
        <svg viewBox={`0 0 ${width} ${HEIGHT}`} width={width} height={HEIGHT} className="block w-full" role="img" aria-hidden="true">
          {ticks.map((tick) => (
            <g key={tick}>
              <line x1={PAD.left} x2={width - PAD.right} y1={y(tick)} y2={y(tick)} stroke="var(--grid)" strokeWidth={1} />
              <text x={PAD.left - 6} y={y(tick)} textAnchor="end" dominantBaseline="middle" fontSize={11} fill="var(--text-muted)">
                {formatNumber(tick, locale)}
              </text>
            </g>
          ))}
          {data.map((point, i) => {
            const x = PAD.left + i * slot + gap / 2;
            const h = (point.visitors / max) * plotH;
            return (
              <g key={point.day}>
                <path d={topRoundedBar(x, y(point.visitors), barW, h, 4)} fill="var(--chart-1)" opacity={active === null || active === i ? 1 : 0.45} />
                {i % labelEvery === 0 && (
                  <text x={x + barW / 2} y={HEIGHT - 6} textAnchor="middle" fontSize={11} fill="var(--text-muted)">
                    {short(point.day)}
                  </text>
                )}
                {/* Hit target: the full column, wider than the mark */}
                <rect
                  x={PAD.left + i * slot}
                  y={PAD.top}
                  width={slot}
                  height={plotH}
                  fill="transparent"
                  onMouseEnter={() => setActive(i)}
                  onTouchStart={() => setActive(i)}
                />
              </g>
            );
          })}
        </svg>
        {activePoint && (
          <div
            role="status"
            className="pointer-events-none absolute top-0 z-10 -translate-x-1/2 whitespace-nowrap rounded-lg border border-border bg-surface px-3 py-2 text-xs shadow-md"
            style={{ left: `${Math.min(Math.max(tooltipLeft, 12), 88)}%` }}
          >
            <p className="font-semibold">{formatDate(activePoint.day, locale)}</p>
            <p className="text-muted">{t("admin.tooltip", { visitors: activePoint.visitors, views: activePoint.views })}</p>
          </div>
        )}
      </div>
      <details className="text-sm">
        <summary className="inline-flex min-h-11 cursor-pointer items-center font-medium text-primary">{t("admin.showTable")}</summary>
        <div className="mt-2 max-h-72 overflow-auto rounded-lg border border-border">
          <table className="w-full text-left text-sm">
            <thead className="sticky top-0 bg-surface-muted">
              <tr>
                <th scope="col" className="px-3 py-2">{t("admin.date")}</th>
                <th scope="col" className="px-3 py-2 text-right">{t("admin.visitorsCol")}</th>
                <th scope="col" className="px-3 py-2 text-right">{t("admin.viewsCol")}</th>
              </tr>
            </thead>
            <tbody>
              {[...data].reverse().map((point) => (
                <tr key={point.day} className="border-t border-border">
                  <td className="px-3 py-1.5">{formatDate(point.day, locale)}</td>
                  <td className="px-3 py-1.5 text-right tabular-nums">{formatNumber(point.visitors, locale)}</td>
                  <td className="px-3 py-1.5 text-right tabular-nums">{formatNumber(point.views, locale)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </figure>
  );
}
