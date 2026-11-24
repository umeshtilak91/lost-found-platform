"use client";

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  Check,
  ImagePlus,
  PackageCheck,
  PackageSearch,
  X,
} from "lucide-react";
import { flashToast } from "@/components/layout/Toaster";
import { errorMessage } from "@/features/auth/AuthProvider";
import { Alert, Button, Field, Input, Select, Textarea } from "@/components/ui";
import { api, ApiError, fieldErrors } from "@/lib/api";
import { FALLBACK_CONNECTION_FEE_PAISE, inr } from "@/lib/money";
import { rewardOf, usePricing } from "@/lib/pricing";
import { todayIso } from "@/lib/format";
import { useI18n } from "@/lib/i18n/client";
import { CATEGORIES, type Item, type ItemType } from "@/lib/types";
import { DEFAULT_COUNTRY, hasCoords, type LocationValue } from "@/lib/location";
import { LocationPicker } from "@/features/search/LocationPicker";

const MAX_PHOTOS = 5;
const MAX_MB = 8;
const ACCEPT = ["image/jpeg", "image/png", "image/webp"];

type Draft = {
  type: ItemType;
  title: string;
  category: string;
  description: string;
  date: string;
  ownershipQuestion: string;
};

function initialPlace(item?: Item): LocationValue {
  if (!item) return { label: "", source: "manual" };
  return {
    label: item.location,
    source: item.locationSource ?? "legacy",
    placeId: item.locationPlaceId ?? undefined,
    lat: item.latitude ?? undefined,
    lng: item.longitude ?? undefined,
    country: item.locationCountry ?? undefined,
    accuracyM: item.locationAccuracyM ?? undefined,
  };
}

export function ItemForm({
  item,
  defaultType = "lost",
}: {
  item?: Item;
  defaultType?: ItemType;
}) {
  const { t, locale } = useI18n();
  const router = useRouter();
  const editing = Boolean(item);
  const [draft, setDraft] = useState<Draft>({
    type: item?.type ?? defaultType,
    title: item?.title ?? "",
    category: item?.category ?? "",
    description: item?.description ?? "",
    date: item?.date ?? todayIso(),
    ownershipQuestion: item?.ownershipQuestion ?? "",
  });
  // Incident location: one structured value from the shared picker. On edit
  // it is only sent when the owner changes it.
  const [place, setPlace] = useState<LocationValue>(() => initialPlace(item));
  const [placeTouched, setPlaceTouched] = useState(false);
  const [placeConfirmed, setPlaceConfirmed] = useState(false);
  const [country, setCountry] = useState(item?.locationCountry || DEFAULT_COUNTRY);
  const legacyLocation = editing && !placeTouched && !item?.hasCoordinates;
  const needsPlaceConfirm = !editing || placeTouched;
  const [files, setFiles] = useState<File[]>([]);
  const [removeIds, setRemoveIds] = useState<number[]>([]);
  const [photoError, setPhotoError] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const errorRef = useRef<HTMLDivElement>(null);
  const pricing = usePricing();
  const [rewardAck, setRewardAck] = useState(false);
  const [ackNotice, setAckNotice] = useState<string | null>(null);
  const [needsReview, setNeedsReview] = useState(false);
  const [reviewRequested, setReviewRequested] = useState(false);
  const rewardPaise = rewardOf(pricing, draft.category);
  const feePaise = pricing?.connectionFeePaise ?? FALLBACK_CONNECTION_FEE_PAISE;
  // Lost-item owners agree to the reward when publishing, and again if the
  // category of an existing lost listing changes.
  const needsAck =
    draft.type === "lost" && (!editing || draft.category !== item?.category);

  const previews = useMemo(
    () => files.map((file) => URL.createObjectURL(file)),
    [files],
  );
  useEffect(
    () => () => previews.forEach((url) => URL.revokeObjectURL(url)),
    [previews],
  );

  const existing = (item?.images ?? []).filter(
    (image) => !removeIds.includes(image.id),
  );
  const set =
    (key: keyof Draft) =>
    (
      event: React.ChangeEvent<
        HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement
      >,
    ) => {
      const value = event.target.value;
      if ((key === "category" || key === "type") && rewardAck) {
        setRewardAck(false);
        const next =
          key === "category" ? rewardOf(pricing, value) : rewardPaise;
        if (next)
          setAckNotice(
            t("reward.lost.ackReset", { amount: inr(next, locale) }),
          );
      }
      setDraft((current) => ({ ...current, [key]: value }));
    };

  function addFiles(list: FileList | null) {
    setPhotoError(null);
    if (!list) return;
    const next = [...files];
    for (const file of Array.from(list)) {
      if (!ACCEPT.includes(file.type)) {
        setPhotoError(t("form.photos.badType", { name: file.name }));
        continue;
      }
      if (file.size > MAX_MB * 1024 * 1024) {
        setPhotoError(t("form.photos.tooBig", { name: file.name, mb: MAX_MB }));
        continue;
      }
      if (existing.length + next.length >= MAX_PHOTOS) {
        setPhotoError(t("form.photos.tooMany", { max: MAX_PHOTOS }));
        break;
      }
      next.push(file);
    }
    setFiles(next);
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setErrors({});
    setFormError(null);
    const early: Record<string, string> = {};
    if (!place.label.trim()) early.location = t("loc.required");
    else if (needsPlaceConfirm && !placeConfirmed) early.locationConfirm = t("loc.confirmRequired");
    if (needsAck && !rewardAck) early.acceptRewardTerms = t("reward.lost.ackRequired");
    if (Object.keys(early).length) {
      setErrors(early);
      setFormError(t("form.errors"));
      requestAnimationFrame(() => errorRef.current?.focus());
      return;
    }
    setSaving(true);

    const form = new FormData();
    for (const [key, value] of Object.entries(draft)) {
      if (key === "type" && editing) continue;
      form.append(key, value);
    }
    if (!editing || placeTouched) {
      form.append("location", place.label.trim());
      if (place.source === "provider" && place.placeId) {
        form.append("locationSource", "provider");
        form.append("locationPlaceId", place.placeId);
      } else if (place.source === "device" && hasCoords(place)) {
        form.append("locationSource", "device");
        form.append("latitude", place.lat.toFixed(6));
        form.append("longitude", place.lng.toFixed(6));
        if (place.accuracyM) form.append("locationAccuracyM", String(place.accuracyM));
      } else {
        form.append("locationSource", "manual");
      }
      form.append("locationCountry", place.country || country);
    }
    if (removeIds.length) form.append("removeImageIds", removeIds.join(","));
    if (needsAck && rewardPaise) {
      form.append("acceptRewardTerms", "true");
      form.append("expectedRewardPaise", String(rewardPaise));
    }
    if (reviewRequested) form.append("reviewRequested", "true");
    for (const file of files) form.append("images", file);

    try {
      const res = await api<{ item: Item }>(
        editing ? `/items/${item!.id}` : "/items",
        { method: editing ? "PATCH" : "POST", form },
      );
      flashToast(
        reviewRequested
          ? t("toast.sentForReview")
          : editing
            ? t("toast.saved")
            : t("toast.published"),
      );
      router.push(`/items/${res.item.id}`);
      router.refresh();
    } catch (error) {
      const fields = fieldErrors(error);
      if (error instanceof ApiError && error.code === "contact_detected") {
        const flagged = (error.details.fields || {}) as Record<
          string,
          string[]
        >;
        for (const key of Object.keys(flagged))
          fields[key] = t("form.contactDetected");
        setNeedsReview(true);
      }
      if (
        error instanceof ApiError &&
        (error.code === "pricing_changed" || error.code === "terms_required")
      ) {
        setRewardAck(false);
        fields.acceptRewardTerms = error.message;
      }
      setErrors(fields);
      setFormError(
        Object.keys(fields).length ? t("form.errors") : errorMessage(error, t),
      );
      if (error instanceof ApiError && error.code === "invalid_image")
        setPhotoError(error.message);
      setSaving(false);
      requestAnimationFrame(() => errorRef.current?.focus());
    }
  }

  return (
    <form onSubmit={submit} noValidate className="flex flex-col gap-6">
      <p className="text-sm text-muted">{t("form.intro")}</p>
      {formError && (
        <div ref={errorRef} tabIndex={-1}>
          <Alert tone="error">{formError}</Alert>
        </div>
      )}

      {!editing && (
        <fieldset>
          <legend className="mb-2 text-sm font-medium">{t("form.type")}</legend>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {(["lost", "found"] as const).map((type) => {
              const Icon = type === "lost" ? PackageSearch : PackageCheck;
              return (
                <label
                  key={type}
                  className="group relative flex min-h-20 cursor-pointer items-center gap-3 rounded-xl border-2 border-border bg-surface px-4 py-3 transition-[border-color,background-color,transform] duration-150 hover:border-primary/60 active:scale-[0.99] has-[:checked]:border-primary has-[:checked]:bg-info-bg has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-primary"
                >
                  <input
                    type="radio"
                    name="type"
                    value={type}
                    checked={draft.type === type}
                    onChange={set("type")}
                    className="peer sr-only"
                  />
                  <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-surface-muted text-muted transition-colors peer-checked:bg-primary peer-checked:text-primary-contrast">
                    <Icon className="size-5" aria-hidden />
                  </span>
                  <span className="font-semibold">
                    {t(`form.type.${type}`)}
                  </span>
                  <span className="absolute right-3 top-3 flex size-6 scale-50 items-center justify-center rounded-full bg-primary text-primary-contrast opacity-0 transition-[opacity,transform] duration-150 peer-checked:scale-100 peer-checked:opacity-100">
                    <Check className="size-4" aria-hidden />
                  </span>
                </label>
              );
            })}
          </div>
        </fieldset>
      )}

      <Field
        label={t("form.itemTitle")}
        hint={t("form.itemTitle.hint")}
        error={errors.title}
      >
        {(props) => (
          <Input
            {...props}
            value={draft.title}
            onChange={set("title")}
            required
            maxLength={120}
            autoComplete="off"
          />
        )}
      </Field>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={t("form.category")} error={errors.category}>
          {(props) => (
            <Select
              {...props}
              value={draft.category}
              onChange={set("category")}
              required
            >
              <option value="" disabled>
                —
              </option>
              {CATEGORIES.map((category) => (
                <option key={category} value={category}>
                  {t(`category.${category}`)}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label={t("form.date")} error={errors.date}>
          {(props) => (
            <Input
              {...props}
              type="date"
              value={draft.date}
              max={todayIso()}
              onChange={set("date")}
              required
            />
          )}
        </Field>
      </div>

      <section
        aria-labelledby="reward-panel-title"
        aria-live="polite"
        className="rounded-xl border border-found/40 bg-found-bg/40 p-4"
      >
        <h2 id="reward-panel-title" className="text-sm font-semibold">
          {t("reward.panelTitle")}
        </h2>
        {!rewardPaise ? (
          <p className="mt-2 text-sm text-muted">
            {t("reward.selectCategory")}
          </p>
        ) : draft.type === "lost" ? (
          <>
            <dl className="mt-3 grid gap-3 sm:grid-cols-2">
              <div>
                <dt className="text-sm text-muted">
                  {t("reward.finderReward")}
                </dt>
                <dd data-testid="form-reward" className="text-xl font-bold">
                  {inr(rewardPaise, locale)}
                </dd>
                <dd className="text-xs text-muted">
                  {t("reward.lost.rewardBody", {
                    amount: inr(rewardPaise, locale),
                  })}
                </dd>
              </div>
              <div>
                <dt className="text-sm text-muted">
                  {t("reward.connectionFee")}
                </dt>
                <dd className="text-xl font-bold">{inr(feePaise, locale)}</dd>
                <dd className="text-xs text-muted">
                  {t("reward.lost.feeBody", { fee: inr(feePaise, locale) })}
                </dd>
              </div>
            </dl>
            <p className="mt-2 text-xs font-medium text-found">
              {t("reward.postingFree")}
            </p>
            {needsAck && (
              <div className="mt-3">
                {ackNotice && !rewardAck && (
                  <p className="mb-2 text-sm text-warn">{ackNotice}</p>
                )}
                <label className="flex cursor-pointer items-start gap-3">
                  <input
                    type="checkbox"
                    className="mt-1 size-5 shrink-0"
                    checked={rewardAck}
                    onChange={(e) => {
                      setRewardAck(e.target.checked);
                      setAckNotice(null);
                    }}
                    aria-invalid={errors.acceptRewardTerms ? true : undefined}
                    aria-describedby={
                      errors.acceptRewardTerms ? "ack-error" : undefined
                    }
                    required
                  />
                  <span className="text-sm">
                    {t("reward.lost.ack", {
                      amount: inr(rewardPaise, locale),
                      fee: inr(feePaise, locale),
                    })}
                  </span>
                </label>
                {errors.acceptRewardTerms && (
                  <p id="ack-error" className="mt-1 text-sm text-lost">
                    {errors.acceptRewardTerms}
                  </p>
                )}
              </div>
            )}
          </>
        ) : (
          <>
            <dl className="mt-3">
              <dt className="text-sm text-muted">
                {t("reward.categoryReward")}
              </dt>
              <dd data-testid="form-reward" className="text-xl font-bold">
                {inr(rewardPaise, locale)}
              </dd>
              <dd className="text-xs text-muted">
                {t("reward.found.rewardBody", {
                  amount: inr(rewardPaise, locale),
                })}
              </dd>
            </dl>
            <p className="mt-2 text-xs">
              {t("reward.found.feeBody", { fee: inr(feePaise, locale) })}
            </p>
            <p className="mt-1 text-xs text-muted">
              {t("reward.found.dependsNote")}
            </p>
          </>
        )}
      </section>

      <section className="flex flex-col gap-3" aria-labelledby="incident-location">
        <span id="incident-location" className="sr-only">
          {t("loc.incidentLabel")}
        </span>
        {legacyLocation && <Alert tone="info">{t("loc.legacyNotice")}</Alert>}
        <LocationPicker
          inputId="item-location"
          mode="incident"
          required
          label={t("loc.incidentLabel")}
          hint={t("loc.incidentHint")}
          error={errors.location || errors.latitude || errors.locationPlaceId}
          value={place}
          onChange={(next) => {
            setPlace(next ?? { label: "", source: "manual" });
            setPlaceTouched(true);
            setPlaceConfirmed(false);
          }}
          country={country}
          onCountryChange={setCountry}
        />
        {needsPlaceConfirm && (
          <label className="flex min-h-11 items-start gap-2 text-sm">
            <input
              type="checkbox"
              className="mt-1 size-4"
              checked={placeConfirmed}
              onChange={(e) => setPlaceConfirmed(e.target.checked)}
              aria-invalid={errors.locationConfirm ? true : undefined}
              aria-describedby={errors.locationConfirm ? "location-confirm-error" : undefined}
            />
            <span>{t("loc.confirm")}</span>
          </label>
        )}
        {errors.locationConfirm && (
          <p id="location-confirm-error" className="-mt-2 text-sm text-lost">
            {errors.locationConfirm}
          </p>
        )}
      </section>

      <Field
        label={t("form.description")}
        hint={t("form.description.hint")}
        error={errors.description}
        optional
        optionalLabel={t("common.optional")}
      >
        {(props) => (
          <Textarea
            {...props}
            value={draft.description}
            onChange={set("description")}
            maxLength={2000}
            rows={4}
          />
        )}
      </Field>

      <Field
        label={t("form.question")}
        hint={t("form.question.hint")}
        error={errors.ownershipQuestion}
      >
        {(props) => (
          <Input
            {...props}
            value={draft.ownershipQuestion}
            onChange={set("ownershipQuestion")}
            maxLength={300}
          />
        )}
      </Field>

      <fieldset>
        <legend className="text-sm font-medium">{t("form.photos")}</legend>
        <p className="mb-2 text-xs text-muted">
          {t("form.photos.hint", { max: MAX_PHOTOS, mb: MAX_MB })}
        </p>
        <ul className="flex flex-wrap gap-3">
          {existing.map((image, index) => (
            <li key={image.id} className="relative">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={image.thumbUrl}
                alt=""
                className="size-24 rounded-lg object-cover transition-[filter] hover:brightness-90"
              />
              <button
                type="button"
                onClick={() => setRemoveIds((ids) => [...ids, image.id])}
                className="absolute -right-2 -top-2 flex size-8 items-center justify-center rounded-full border border-border bg-surface shadow transition-colors hover:border-lost hover:text-lost"
                aria-label={t("form.photos.remove", { n: index + 1 })}
              >
                <X className="size-4" aria-hidden />
              </button>
            </li>
          ))}
          {previews.map((url, index) => (
            <li key={url} className="relative">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={url}
                alt=""
                className="size-24 rounded-lg object-cover transition-[filter] hover:brightness-90"
              />
              <button
                type="button"
                onClick={() =>
                  setFiles((list) => list.filter((_, i) => i !== index))
                }
                className="absolute -right-2 -top-2 flex size-8 items-center justify-center rounded-full border border-border bg-surface shadow transition-colors hover:border-lost hover:text-lost"
                aria-label={t("form.photos.remove", {
                  n: existing.length + index + 1,
                })}
              >
                <X className="size-4" aria-hidden />
              </button>
            </li>
          ))}
          {existing.length + files.length < MAX_PHOTOS && (
            <li>
              <label className="flex size-24 cursor-pointer flex-col items-center justify-center gap-1 rounded-lg border-2 border-dashed border-border text-xs text-muted focus-within:ring-2 focus-within:ring-primary hover:bg-surface-muted">
                <ImagePlus className="size-6" aria-hidden />
                {t("form.photos.add")}
                <input
                  type="file"
                  accept={ACCEPT.join(",")}
                  multiple
                  className="sr-only"
                  data-testid="photo-input"
                  onChange={(event) => {
                    addFiles(event.target.files);
                    event.target.value = "";
                  }}
                />
              </label>
            </li>
          )}
        </ul>
        {photoError && (
          <Alert tone="error" className="mt-3">
            {photoError}
          </Alert>
        )}
      </fieldset>

      {needsReview && (
        <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-warn/40 bg-warn-bg p-3">
          <input
            type="checkbox"
            className="mt-1 size-5 shrink-0"
            checked={reviewRequested}
            onChange={(e) => setReviewRequested(e.target.checked)}
          />
          <span className="text-sm">{t("form.requestReview")}</span>
        </label>
      )}

      <div className="flex gap-2">
        <Button type="submit" loading={saving} className="w-full sm:w-auto">
          {saving
            ? t("form.saving")
            : editing
              ? t("form.submit.edit")
              : t("form.submit.create")}
        </Button>
      </div>
    </form>
  );
}
