"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import clsx from "clsx";
import { ChevronLeft, ChevronRight, ImageOff, X, ZoomIn } from "lucide-react";
import { useI18n } from "@/lib/i18n/client";
import type { ItemImage } from "@/lib/types";

// Photo gallery with a full-screen viewer:
// - click/Enter on the main photo opens it; thumbnails switch photos
// - viewer: arrows / ← → keys / swipe to move, Esc or backdrop to close
// - native <dialog> gives focus containment and returns focus on close
export function ImageGallery({ images, title }: { images: ItemImage[]; title: string }) {
  const { t } = useI18n();
  const [index, setIndex] = useState(0);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const openerRef = useRef<HTMLButtonElement>(null);
  const touchStart = useRef<number | null>(null);

  const count = images.length;
  const go = useCallback((delta: number) => setIndex((i) => (i + delta + count) % count), [count]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "ArrowRight") go(1);
      if (event.key === "ArrowLeft") go(-1);
    };
    dialog.addEventListener("keydown", onKey);
    return () => dialog.removeEventListener("keydown", onKey);
  }, [go]);

  if (count === 0) {
    return (
      <div className="flex aspect-[4/3] items-center justify-center rounded-xl bg-surface-muted text-muted">
        <ImageOff className="size-10" aria-hidden />
        <span className="sr-only">{t("item.noPhotos")}</span>
      </div>
    );
  }

  const current = images[Math.min(index, count - 1)];
  const photoLabel = t("item.photo", { n: index + 1, total: count });
  const open = () => dialogRef.current?.showModal();
  const close = () => {
    dialogRef.current?.close();
    openerRef.current?.focus();
  };

  return (
    <div className="flex flex-col gap-3">
      <button
        ref={openerRef}
        type="button"
        onClick={open}
        aria-label={t("item.openPhoto", { n: index + 1 })}
        className="group relative flex aspect-[4/3] cursor-zoom-in items-center justify-center overflow-hidden rounded-xl bg-surface-muted"
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          key={current.id}
          src={current.url}
          alt={`${title} — ${photoLabel}`}
          width={current.width}
          height={current.height}
          className="fade-in max-h-full max-w-full object-contain transition-transform duration-300 group-hover:scale-[1.02] motion-reduce:group-hover:scale-100"
        />
        <span className="absolute bottom-3 right-3 flex items-center gap-1 rounded-full bg-black/60 px-2.5 py-1 text-xs font-medium text-white opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100">
          <ZoomIn className="size-4" aria-hidden />
          {count > 1 ? photoLabel : null}
        </span>
      </button>

      {count > 1 && (
        <ul className="flex gap-2 overflow-x-auto p-1" aria-label={photoLabel}>
          {images.map((image, i) => (
            <li key={image.id}>
              <button
                type="button"
                onClick={() => setIndex(i)}
                aria-current={i === index}
                aria-label={t("item.photo", { n: i + 1, total: count })}
                className={clsx(
                  "block size-16 overflow-hidden rounded-lg border-2 transition-[border-color,transform] duration-150 hover:-translate-y-0.5 sm:size-20",
                  i === index ? "border-primary" : "border-transparent opacity-80 hover:opacity-100"
                )}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={image.thumbUrl} alt="" loading="lazy" className="size-full object-cover" />
              </button>
            </li>
          ))}
        </ul>
      )}

      <dialog
        ref={dialogRef}
        aria-label={title}
        onClose={() => openerRef.current?.focus()}
        onClick={(event) => {
          if (event.target === event.currentTarget) close();
        }}
        className="m-0 h-dvh max-h-none w-screen max-w-none bg-black/95 p-0 text-white backdrop:bg-black/90"
      >
        <div
          className="flex h-full w-full flex-col"
          onTouchStart={(e) => (touchStart.current = e.touches[0].clientX)}
          onTouchEnd={(e) => {
            if (touchStart.current === null) return;
            const dx = e.changedTouches[0].clientX - touchStart.current;
            if (Math.abs(dx) > 40) go(dx < 0 ? 1 : -1);
            touchStart.current = null;
          }}
        >
          <div className="flex items-center justify-between p-3">
            <p className="text-sm" aria-live="polite">
              {photoLabel}
            </p>
            <button type="button" onClick={close} autoFocus aria-label={t("item.closeViewer")} className="flex size-11 items-center justify-center rounded-full hover:bg-white/15">
              <X className="size-6" aria-hidden />
            </button>
          </div>
          <div className="relative flex min-h-0 flex-1 items-center justify-center px-2 pb-6" onClick={(e) => e.target === e.currentTarget && close()}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img key={current.id} src={current.url} alt={`${title} — ${photoLabel}`} className="fade-in max-h-full max-w-full object-contain" />
            {count > 1 && (
              <>
                <button
                  type="button"
                  onClick={() => go(-1)}
                  aria-label={t("item.prevPhoto")}
                  className="absolute left-2 top-1/2 flex size-12 -translate-y-1/2 items-center justify-center rounded-full bg-black/50 hover:bg-white/20"
                >
                  <ChevronLeft className="size-7" aria-hidden />
                </button>
                <button
                  type="button"
                  onClick={() => go(1)}
                  aria-label={t("item.nextPhoto")}
                  className="absolute right-2 top-1/2 flex size-12 -translate-y-1/2 items-center justify-center rounded-full bg-black/50 hover:bg-white/20"
                >
                  <ChevronRight className="size-7" aria-hidden />
                </button>
              </>
            )}
          </div>
        </div>
      </dialog>
    </div>
  );
}
