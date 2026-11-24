"use client";

import { useState } from "react";
import clsx from "clsx";
import { Check, CheckCircle2, Handshake, LifeBuoy, PackageCheck } from "lucide-react";
import { errorMessage } from "@/features/auth/AuthProvider";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { useToast } from "@/components/layout/Toaster";
import { Alert, Badge, Button, Card, Field, Textarea } from "@/components/ui";
import { api } from "@/lib/api";
import { formatDateTime } from "@/lib/format";
import { inr } from "@/lib/money";
import { useI18n } from "@/lib/i18n/client";
import type { Claim } from "@/lib/types";

export type MatchClaim = Pick<
  Claim,
  "id" | "itemId" | "status" | "agreement" | "payment" | "returnConfirmedAt" | "handoverAt" | "returnState" | "returnIssueOpen" | "reward"
>;

type Dialog = null | "receive" | "problem" | "handover" | "correction" | "rewardIssue";

// Return lifecycle for an accepted, connected match:
//   finder "I handed over this item"  ─┐
//   owner  "I received my item"  ──────┴─▶ Returned ─▶ finder reward receipt
// Return and reward are separate facts; neither is verified by the gateway.
export function MatchPanel({ claim, role, onChange }: { claim: MatchClaim; role: "owner" | "finder"; onChange: () => void }) {
  const { t, locale } = useI18n();
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [note, setNote] = useState("");
  const [refundOpen, setRefundOpen] = useState(false);
  const [refundReason, setRefundReason] = useState("");
  const [refundSent, setRefundSent] = useState(false);
  const [correctionSent, setCorrectionSent] = useState(false);

  const state = claim.returnState ?? "arranging";
  const returned = state === "returned";

  // One request at a time: the button stays disabled until the server answers.
  async function run(key: string, path: string, json: unknown, success: string, tone: "success" | "info" = "success") {
    if (busy) return false;
    setBusy(key);
    setError(null);
    try {
      await api(path, { method: "POST", json });
      toast(success, tone);
      setDialog(null);
      setNote("");
      onChange();
      return true;
    } catch (err) {
      setError(errorMessage(err, t));
      return false;
    } finally {
      setBusy(null);
    }
  }
  const close = () => {
    if (busy) return;
    setDialog(null);
    setError(null);
    setNote("");
  };

  const steps = [
    { key: "connected", label: t("return.step.connected"), done: true },
    { key: "handover", label: t("return.step.handover"), done: Boolean(claim.handoverAt) || returned },
    { key: "received", label: t("return.step.received"), done: returned },
  ];
  const stateLabel = { awaiting_connection: t("return.state.awaiting_connection"), arranging: t("return.state.arranging"), awaiting_owner: t("return.state.awaiting_owner"), returned: t("return.state.returned") }[state];
  const rewardTone = claim.reward.status === "confirmed" ? "success" : claim.reward.status === "issue" ? "lost" : "warn";
  const dialogError = error && dialog ? <Alert tone="error">{error}</Alert> : null;

  return (
    <Card className="border-found/50" data-testid="return-panel">
      {claim.agreement && (
        <div>
          <p className="flex items-center gap-1.5 text-sm text-muted">
            <Handshake className="size-4" aria-hidden />
            {t("reward.agreed")}
          </p>
          <p className="mt-1 text-sm">{t("reward.agreedBody", { amount: inr(claim.agreement.rewardPaise, locale) })}</p>
        </div>
      )}

      <h2 className="mt-4 flex items-center gap-2 font-semibold">
        <PackageCheck className="size-4" aria-hidden />
        <span data-testid="return-status">{stateLabel}</span>
      </h2>
      <ol className="mt-3 flex flex-col gap-2 text-sm" aria-label={t("return.progress")}>
        {steps.map((step) => (
          <li key={step.key} className="flex items-center gap-2">
            <span
              className={clsx("flex size-5 items-center justify-center rounded-full border", step.done ? "border-found bg-found text-white" : "border-border text-muted")}
              aria-hidden
            >
              {step.done && <Check className="size-3" />}
            </span>
            <span className={step.done ? "" : "text-muted"}>{step.label}</span>
            <span className="sr-only">{step.done ? t("return.stepDone") : t("return.stepPending")}</span>
          </li>
        ))}
      </ol>

      {returned && claim.returnConfirmedAt && (
        <Alert tone="success" className="mt-3">
          {t("return.confirmed", { date: formatDateTime(claim.returnConfirmedAt, locale) })}
        </Alert>
      )}
      {!returned && state === "awaiting_owner" && (
        <Alert tone="info" className="mt-3">
          {role === "owner" ? t("return.owner.awaiting") : t("return.finder.awaiting")}
        </Alert>
      )}
      {!returned && claim.returnIssueOpen && (
        <Alert tone="warn" className="mt-3">
          {t("return.issueOpen")}
        </Alert>
      )}
      {error && !dialog && (
        <Alert tone="error" className="mt-3">
          {error}
        </Alert>
      )}

      <div className="mt-4 flex flex-col gap-2">
        {!returned && role === "owner" && (
          <Button type="button" onClick={() => setDialog("receive")}>
            {t("return.ownerAction")}
          </Button>
        )}
        {!returned && role === "finder" && !claim.handoverAt && (
          <Button type="button" onClick={() => setDialog("handover")}>
            {t("return.finderAction")}
          </Button>
        )}
        {!returned && !claim.returnIssueOpen && (role === "finder" ? Boolean(claim.handoverAt) : false) && (
          <Button type="button" variant="secondary" onClick={() => setDialog("problem")}>
            <LifeBuoy className="size-4" aria-hidden />
            {t("return.contactSupport")}
          </Button>
        )}
      </div>

      {returned && (
        <section className="mt-5 border-t border-border pt-4" aria-labelledby={`reward-${claim.id}`}>
          <h3 id={`reward-${claim.id}`} className="flex items-center gap-2 text-sm font-semibold">
            <CheckCircle2 className="size-4 text-muted" aria-hidden />
            {t("reward.sectionTitle")}
          </h3>
          <p className="mt-2">
            <Badge tone={rewardTone}>{t(`reward.status.${claim.reward.status}`)}</Badge>
          </p>
          <p className="mt-2 text-xs text-muted">{t("reward.externalNote")}</p>
          {role === "finder" && claim.reward.status !== "confirmed" && (
            <div className="mt-3 flex flex-col gap-2">
              <Button type="button" loading={busy === "confirm"} onClick={() => run("confirm", `/claims/${claim.id}/reward`, { status: "confirmed" }, t("toast.rewardConfirmed"))}>
                {t("reward.finderConfirm")}
              </Button>
              {claim.reward.status !== "issue" && (
                <Button type="button" variant="secondary" onClick={() => setDialog("rewardIssue")}>
                  {t("reward.finderIssue")}
                </Button>
              )}
            </div>
          )}
          {correctionSent ? (
            <Alert tone="success" className="mt-3">
              {t("return.correctionSent")}
            </Alert>
          ) : (
            <Button type="button" variant="ghost" className="mt-2 text-muted" onClick={() => setDialog("correction")}>
              {t("return.correctionRequest")}
            </Button>
          )}
        </section>
      )}

      {role === "owner" && claim.payment.status === "paid" && !returned && (
        <div className="mt-3 border-t border-border pt-3">
          {refundSent ? (
            <Alert tone="success">{t("refund.sent")}</Alert>
          ) : refundOpen ? (
            <form
              className="flex flex-col gap-2"
              onSubmit={async (e) => {
                e.preventDefault();
                setBusy("refund");
                setError(null);
                try {
                  await api(`/claims/${claim.id}/refund-request`, { method: "POST", json: { reason: refundReason.trim() } });
                  setRefundSent(true);
                  toast(t("refund.sent"), "info");
                } catch (err) {
                  setError(errorMessage(err, t));
                } finally {
                  setBusy(null);
                }
              }}
            >
              <Field label={t("refund.reason")}>{(props) => <Textarea {...props} value={refundReason} onChange={(e) => setRefundReason(e.target.value)} minLength={10} maxLength={1000} required />}</Field>
              <Button type="submit" variant="secondary" loading={busy === "refund"}>
                {t("refund.submit")}
              </Button>
              <a href="/pricing#refunds" className="text-xs text-primary underline">
                {t("refund.policyLink")}
              </a>
            </form>
          ) : (
            <Button type="button" variant="ghost" className="text-muted" onClick={() => setRefundOpen(true)}>
              {t("refund.request")}
            </Button>
          )}
        </div>
      )}

      {/* Owner: "Have you received your item?" */}
      <ConfirmDialog
        open={dialog === "receive"}
        title={t("return.dialog.title")}
        onCancel={close}
        busy={Boolean(busy)}
        actions={
          <>
            <Button type="button" loading={busy === "receive"} disabled={Boolean(busy)} onClick={() => run("receive", `/claims/${claim.id}/return`, {}, t("toast.returnConfirmed"))}>
              {t("return.dialog.yes")}
            </Button>
            <Button type="button" variant="secondary" disabled={Boolean(busy)} onClick={() => setDialog("problem")}>
              {t("return.dialog.problem")}
            </Button>
            <Button type="button" variant="ghost" disabled={Boolean(busy)} onClick={close}>
              {t("common.cancel")}
            </Button>
          </>
        }
      >
        <p>{t("return.dialog.body")}</p>
        {dialogError}
      </ConfirmDialog>

      {/* "There is a problem" / contact support (return stays unresolved) */}
      <ConfirmDialog
        open={dialog === "problem"}
        title={t("return.problem.title")}
        onCancel={close}
        busy={Boolean(busy)}
        actions={
          <>
            <Button
              type="button"
              loading={busy === "problem"}
              disabled={Boolean(busy) || note.trim().length < 5}
              disabledReason={t("disabled.needMessage")}
              onClick={() => run("problem", `/claims/${claim.id}/return-issue`, { note: note.trim() }, t("toast.problemRecorded"), "info")}
            >
              {t("return.problem.submit")}
            </Button>
            <Button type="button" variant="ghost" disabled={Boolean(busy)} onClick={close}>
              {t("common.cancel")}
            </Button>
          </>
        }
      >
        <p className="mb-3">{t("return.problem.body")}</p>
        <Field label={t("return.problem.label")}>{(props) => <Textarea {...props} value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} />}</Field>
        {dialogError}
      </ConfirmDialog>

      {/* Finder: handover */}
      <ConfirmDialog
        open={dialog === "handover"}
        title={t("return.handover.title")}
        onCancel={close}
        busy={Boolean(busy)}
        actions={
          <>
            <Button type="button" loading={busy === "handover"} disabled={Boolean(busy)} onClick={() => run("handover", `/claims/${claim.id}/handover`, {}, t("toast.handoverReported"))}>
              {t("return.handover.yes")}
            </Button>
            <Button type="button" variant="ghost" disabled={Boolean(busy)} onClick={close}>
              {t("common.cancel")}
            </Button>
          </>
        }
      >
        <p>{t("return.handover.body")}</p>
        {dialogError}
      </ConfirmDialog>

      {/* Finder: reward payment issue */}
      <ConfirmDialog
        open={dialog === "rewardIssue"}
        title={t("reward.finderIssue")}
        onCancel={close}
        busy={Boolean(busy)}
        actions={
          <>
            <Button
              type="button"
              loading={busy === "issue"}
              disabled={Boolean(busy) || !note.trim()}
              disabledReason={t("disabled.needMessage")}
              onClick={() => run("issue", `/claims/${claim.id}/reward`, { status: "issue", note: note.trim() }, t("toast.rewardIssue"), "info")}
            >
              {t("reward.issueSubmit")}
            </Button>
            <Button type="button" variant="ghost" disabled={Boolean(busy)} onClick={close}>
              {t("common.cancel")}
            </Button>
          </>
        }
      >
        <p className="mb-3">{t("reward.issueBody")}</p>
        <Field label={t("reward.issueNote")}>{(props) => <Textarea {...props} value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} />}</Field>
        {dialogError}
      </ConfirmDialog>

      {/* Either participant: correction of an accidental completion */}
      <ConfirmDialog
        open={dialog === "correction"}
        title={t("return.correction.title")}
        onCancel={close}
        busy={Boolean(busy)}
        actions={
          <>
            <Button
              type="button"
              loading={busy === "correction"}
              disabled={Boolean(busy) || note.trim().length < 10}
              disabledReason={t("disabled.needMessage")}
              onClick={async () => {
                if (await run("correction", `/items/${claim.itemId}/correction-request`, { reason: note.trim() }, t("return.correctionSent"), "info")) setCorrectionSent(true);
              }}
            >
              {t("return.correction.submit")}
            </Button>
            <Button type="button" variant="ghost" disabled={Boolean(busy)} onClick={close}>
              {t("common.cancel")}
            </Button>
          </>
        }
      >
        <p className="mb-3">{t("return.correction.body")}</p>
        <Field label={t("return.correction.label")}>{(props) => <Textarea {...props} value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} />}</Field>
        {dialogError}
      </ConfirmDialog>
    </Card>
  );
}
