"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { CreditCard, FlaskConical, Handshake } from "lucide-react";
import { errorMessage, useAuth } from "@/features/auth/AuthProvider";
import { flashToast, useToast } from "@/components/layout/Toaster";
import { Alert, Button, Card } from "@/components/ui";
import { api } from "@/lib/api";
import { inr } from "@/lib/money";
import { useI18n } from "@/lib/i18n/client";

type CheckoutConfig = { provider: "razorpay" | "test"; keyId: string; orderId: string; amountPaise: number; currency: "INR"; rewardPaise: number; claimId: number };
type VerifyResult = { status: string };

declare global {
  interface Window {
    Razorpay?: new (options: Record<string, unknown>) => { open: () => void; on: (event: string, cb: (r: unknown) => void) => void };
  }
}

function loadRazorpay(): Promise<void> {
  if (window.Razorpay) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "https://checkout.razorpay.com/v1/checkout.js";
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("checkout_script"));
    document.body.appendChild(script);
  });
}

// "Connect with the finder": shows the ₹100 fee paid now and the agreed
// reward paid directly at handover, then runs checkout. The amount shown is
// display-only; the server fixes the order at ₹100 INR.
export function CheckoutCard({ claimId, rewardPaise, feePaise, conversationId, onPaid }: { claimId: number; rewardPaise: number; feePaise: number; conversationId?: number | null; onPaid?: () => void }) {
  const { t, locale } = useI18n();
  const { user } = useAuth();
  const toast = useToast();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "error" | "info" | "warn"; text: string } | null>(null);
  const [testOrder, setTestOrder] = useState<CheckoutConfig | null>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const fee = inr(feePaise, locale);
  const amount = inr(rewardPaise, locale);

  const finish = useCallback(
    (result: VerifyResult) => {
      if (result.status === "paid") {
        flashToast(t("toast.connected"));
        onPaid?.();
        if (conversationId) router.push(`/inbox/${conversationId}`);
        else router.refresh();
        return;
      }
      if (result.status === "pending") setMessage({ tone: "info", text: t("checkout.pending") });
      else setMessage({ tone: "error", text: t("checkout.failed") });
    },
    [conversationId, onPaid, router, t]
  );

  // While a payment is pending, poll the status endpoint (it reconciles with
  // the provider, covering missed callbacks or a closed tab).
  useEffect(() => {
    if (message?.text !== t("checkout.pending")) return;
    const timer = setInterval(async () => {
      const state = await api<{ status: string }>(`/claims/${claimId}/payment`).catch(() => null);
      if (state?.status === "paid") {
        clearInterval(timer);
        finish({ status: "paid" });
      }
    }, 3000);
    return () => clearInterval(timer);
  }, [message, claimId, finish, t]);

  async function verify(orderId: string, paymentId: string, signature: string) {
    setMessage({ tone: "info", text: t("checkout.processing") });
    try {
      finish(await api<VerifyResult>("/payments/verify", { method: "POST", json: { orderId, paymentId, signature } }));
    } catch (error) {
      setMessage({ tone: "error", text: errorMessage(error, t) });
    }
  }

  async function start() {
    setBusy(true);
    setMessage(null);
    try {
      const { checkout } = await api<{ checkout: CheckoutConfig }>(`/claims/${claimId}/checkout`, { method: "POST", json: {} });
      if (checkout.provider === "test") {
        setTestOrder(checkout);
        dialogRef.current?.showModal();
        return;
      }
      await loadRazorpay();
      const rzp = new window.Razorpay!({
        key: checkout.keyId,
        amount: checkout.amountPaise,
        currency: checkout.currency,
        order_id: checkout.orderId,
        name: t("app.name"),
        description: t("checkout.platformFee", { fee }),
        handler: (resp: { razorpay_payment_id: string; razorpay_order_id: string; razorpay_signature: string }) =>
          verify(checkout.orderId, resp.razorpay_payment_id, resp.razorpay_signature),
        modal: {
          ondismiss: () => {
            api(`/payments/${checkout.orderId}/cancel`, { method: "POST", json: {} }).catch(() => {});
            setMessage({ tone: "warn", text: t("checkout.cancelled") });
          },
        },
        // Prefill the payer's own details so Razorpay doesn't ask again.
        prefill: { name: user?.name ?? undefined, email: user?.email ?? undefined, contact: user?.phone ?? undefined },
        notes: { claim_id: String(claimId) },
        theme: { color: "#1d4ed8" },
      });
      rzp.on("payment.failed", () => setMessage({ tone: "error", text: t("checkout.failed") }));
      rzp.open();
    } catch (error) {
      setMessage({ tone: "error", text: errorMessage(error, t) });
    } finally {
      setBusy(false);
    }
  }

  async function simulate(outcome: "success" | "failure") {
    if (!testOrder) return;
    dialogRef.current?.close();
    const done = await api<{ paymentId: string; signature: string }>("/payments/test/complete", { method: "POST", json: { orderId: testOrder.orderId, outcome } });
    await verify(testOrder.orderId, done.paymentId, done.signature);
    if (outcome === "success") toast(t("toast.connected"));
  }

  async function cancelTest() {
    dialogRef.current?.close();
    if (testOrder) await api(`/payments/${testOrder.orderId}/cancel`, { method: "POST", json: {} }).catch(() => {});
    setMessage({ tone: "warn", text: t("checkout.cancelled") });
  }

  return (
    <Card className="border-primary/50">
      <h2 className="text-lg font-semibold">{t("checkout.title")}</h2>
      <p className="mt-1 text-sm text-muted">{t("checkout.accepted")}</p>
      <dl className="mt-4 grid gap-3 sm:grid-cols-2">
        <div className="rounded-lg border border-border p-3">
          <dt className="flex items-center gap-1.5 text-sm text-muted">
            <CreditCard className="size-4" aria-hidden />
            {t("checkout.payNow")}
          </dt>
          <dd className="mt-1 font-semibold">{t("checkout.platformFee", { fee })}</dd>
        </div>
        <div className="rounded-lg border border-border p-3">
          <dt className="flex items-center gap-1.5 text-sm text-muted">
            <Handshake className="size-4" aria-hidden />
            {t("checkout.payAtHandover")}
          </dt>
          <dd className="mt-1 font-semibold">{t("checkout.finderReward", { amount })}</dd>
        </div>
      </dl>
      <p className="mt-3 text-xs text-muted">{t("checkout.note")}</p>
      {message && (
        <Alert tone={message.tone} className="mt-3">
          {message.text}
        </Alert>
      )}
      <Button type="button" className="mt-4 w-full" onClick={start} loading={busy}>
        {t("checkout.button", { fee })}
      </Button>

      <dialog ref={dialogRef} aria-labelledby="test-checkout-title" className="m-auto w-[min(92vw,420px)] rounded-xl border border-border bg-surface p-0 text-text backdrop:bg-black/60">
        <div className="flex flex-col gap-3 p-5">
          <h3 id="test-checkout-title" className="flex items-center gap-2 font-semibold">
            <FlaskConical className="size-5 text-warn" aria-hidden />
            {t("checkout.testTitle")}
          </h3>
          <p className="text-sm text-muted">{t("checkout.testBody")}</p>
          <p className="text-sm font-semibold">{t("checkout.platformFee", { fee: inr(testOrder?.amountPaise ?? feePaise, locale) })}</p>
          <Button type="button" onClick={() => simulate("success")} autoFocus>
            {t("checkout.testSuccess")}
          </Button>
          <Button type="button" variant="secondary" onClick={() => simulate("failure")}>
            {t("checkout.testFailure")}
          </Button>
          <Button type="button" variant="ghost" onClick={cancelTest}>
            {t("actions.cancel")}
          </Button>
        </div>
      </dialog>
    </Card>
  );
}
