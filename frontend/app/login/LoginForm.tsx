"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { CheckCircle2, MailCheck } from "lucide-react";
import { errorMessage, useAuth } from "@/features/auth/AuthProvider";
import { flashToast } from "@/components/layout/Toaster";
import { Alert, Button, Field, Input } from "@/components/ui";
import { api, ApiError } from "@/lib/api";
import { useI18n } from "@/lib/i18n/client";
import type { User } from "@/lib/types";

type Providers = { google: boolean; apple: boolean; email: boolean };
type Challenge = { challengeId: string; email: string; expiresAt: string; resendAvailableAt: string; delivery: "sent" | "unconfirmed" };
type Step = "email" | "code" | "done";

// Only allow same-site relative paths as post-login destinations (the API validates again).
function safeNext(value: string | null) {
  return value && value.startsWith("/") && !value.startsWith("//") && !value.startsWith("/\\") ? value : "/";
}

function useCountdown(target: string | null) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!target) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [target]);
  // Round down so small clock differences never show more than the real limit (e.g. "5:01").
  return target ? Math.max(0, Math.floor((new Date(target).getTime() - now) / 1000)) : 0;
}

export function LoginForm() {
  const { t } = useI18n();
  const router = useRouter();
  const params = useSearchParams();
  const { user, setSession } = useAuth();
  const [providers, setProviders] = useState<Providers | null>(null);
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [step, setStep] = useState<Step>("email");
  const [challenge, setChallenge] = useState<Challenge | null>(null);
  const [busy, setBusy] = useState<"send" | "verify" | null>(null);
  const [error, setError] = useState<{ text: string; canResend?: boolean } | null>(null);
  const [cooldownUntil, setCooldownUntil] = useState<string | null>(null);
  const codeRef = useRef<HTMLInputElement>(null);
  const next = safeNext(params.get("next"));
  const oauthError = params.get("error");
  const resendIn = useCountdown(cooldownUntil);
  const expiresIn = useCountdown(challenge?.expiresAt ?? null);

  useEffect(() => {
    api<Providers>("/auth/providers").then(setProviders).catch(() => setProviders({ google: false, apple: false, email: false }));
  }, []);
  useEffect(() => {
    if (user && step !== "done") router.replace(next);
  }, [user, next, router, step]);
  useEffect(() => {
    if (step === "code") codeRef.current?.focus();
  }, [step]);

  async function requestCode(event?: React.FormEvent) {
    event?.preventDefault();
    setBusy("send");
    setError(null);
    try {
      const res = await api<Challenge>("/auth/email/request", { method: "POST", json: { email } });
      setChallenge(res);
      setCooldownUntil(res.resendAvailableAt);
      setCode("");
      setStep("code");
    } catch (err) {
      if (err instanceof ApiError && err.code === "otp_cooldown") {
        const retry = Number(err.details.retryAfter) || 60;
        setCooldownUntil(new Date(Date.now() + retry * 1000).toISOString());
        setError({ text: t("login.cooldown", { seconds: retry }) });
        if (challenge) setStep("code");
      } else if (err instanceof ApiError && err.code === "email_delivery_failed") {
        setError({ text: t("login.deliveryFailed") });
      } else setError({ text: errorMessage(err, t) });
    } finally {
      setBusy(null);
    }
  }

  async function verify(value = code) {
    if (!challenge || value.length !== 6 || busy) return;
    setBusy("verify");
    setError(null);
    try {
      const res = await api<{ user: User; csrfToken: string; redirectTo: string }>("/auth/email/verify", {
        method: "POST",
        json: { challengeId: challenge.challengeId, code: value, email: challenge.email, next },
      });
      setStep("done");
      setSession(res.user, res.csrfToken);
      flashToast(t("login.success"));
      router.replace(safeNext(res.redirectTo));
      router.refresh();
    } catch (err) {
      const codeName = err instanceof ApiError ? err.code : "";
      const messages: Record<string, { text: string; canResend?: boolean }> = {
        invalid_code: { text: err instanceof ApiError ? err.message : t("login.wrongCode") },
        otp_expired: { text: t("login.expired"), canResend: true },
        otp_locked: { text: t("login.locked"), canResend: true },
        otp_superseded: { text: t("login.superseded") },
        otp_used: { text: t("login.used"), canResend: true },
        invalid_challenge: { text: t("login.used"), canResend: true },
      };
      setError(messages[codeName] ?? { text: errorMessage(err, t) });
      setCode("");
      codeRef.current?.focus();
    } finally {
      setBusy(null);
    }
  }

  function onCodeChange(raw: string) {
    // Accepts typing, paste ("123 456", "123-456") and one-time-code autofill.
    const digits = raw.replace(/\D/g, "").slice(0, 6);
    setCode(digits);
    if (digits.length === 6) verify(digits);
  }

  function changeEmail() {
    setStep("email");
    setCode("");
    setChallenge(null);
    setError(null);
  }

  const providerHref = (name: "google" | "apple") => `/api/auth/${name}`;

  if (step === "done") {
    return (
      <Alert tone="success">
        <span className="flex items-center gap-2">
          <CheckCircle2 className="size-4" aria-hidden />
          {t("login.success")}
        </span>
      </Alert>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {oauthError === "oauth_failed" && <Alert tone="error">{t("login.oauthFailed")}</Alert>}
      {(oauthError === "google_unconfigured" || (providers && !providers.google)) && <Alert tone="warn">{t("login.googleUnavailable")}</Alert>}

      {providers?.google && step === "email" && (
        <a
          href={providerHref("google")}
          className="inline-flex min-h-12 items-center justify-center gap-3 rounded-lg border border-border bg-surface px-4 font-semibold transition-[background-color,border-color,transform] hover:border-primary/60 hover:bg-surface-muted active:translate-y-px"
        >
          <svg aria-hidden viewBox="0 0 24 24" className="size-5">
            <path fill="#EA4335" d="M12 10.2v3.9h5.5c-.2 1.3-1.6 3.8-5.5 3.8-3.3 0-6-2.7-6-6.1s2.7-6.1 6-6.1c1.9 0 3.1.8 3.8 1.5l2.6-2.5C16.8 3.2 14.6 2.2 12 2.2 6.6 2.2 2.2 6.6 2.2 12s4.4 9.8 9.8 9.8c5.7 0 9.4-4 9.4-9.6 0-.6-.1-1.1-.2-1.6H12z" />
          </svg>
          {t("login.google")}
        </a>
      )}
      {providers?.apple && step === "email" && (
        <a href={providerHref("apple")} className="inline-flex min-h-12 items-center justify-center rounded-lg bg-text px-4 font-semibold text-bg hover:opacity-90">
          {t("login.apple")}
        </a>
      )}

      {providers?.email && (
        <>
          {(providers.google || providers.apple) && step === "email" && (
            <div className="flex items-center gap-3 text-sm text-muted" aria-hidden>
              <span className="h-px flex-1 bg-border" />
              {t("login.or")}
              <span className="h-px flex-1 bg-border" />
            </div>
          )}

          {step === "email" ? (
            <form onSubmit={requestCode} className="flex flex-col gap-3" noValidate>
              {error && <Alert tone="error">{error.text}</Alert>}
              <Field label={t("login.email")}>
                {(props) => <Input {...props} type="email" autoComplete="email" inputMode="email" value={email} onChange={(e) => setEmail(e.target.value)} required />}
              </Field>
              <Button type="submit" loading={busy === "send"} disabled={!/^\S+@\S+\.\S+$/.test(email.trim())} disabledReason={t("login.enterEmail")}>
                {busy === "send" ? t("login.sending") : t("login.sendCode")}
              </Button>
            </form>
          ) : (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                verify();
              }}
              className="flex flex-col gap-3"
            >
              <div role="status" className="flex items-start gap-2 rounded-lg border border-primary/30 bg-info-bg p-3 text-sm">
                <MailCheck className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden />
                <span>
                  {t("login.codeSentTo")} <strong data-testid="otp-recipient">{challenge?.email}</strong>
                  <span className="block text-xs text-muted">
                    {expiresIn > 0 ? t("login.expiresIn", { time: `${Math.floor(expiresIn / 60)}:${String(expiresIn % 60).padStart(2, "0")}` }) : t("login.expired")}
                  </span>
                </span>
              </div>
              {challenge?.delivery === "unconfirmed" && <Alert tone="warn">{t("login.unconfirmed")}</Alert>}
              {error && (
                <Alert tone="error">
                  {error.text}
                  {error.canResend && resendIn === 0 && (
                    <button type="button" onClick={() => requestCode()} className="ml-2 font-semibold underline">
                      {t("login.resend")}
                    </button>
                  )}
                </Alert>
              )}
              <Field label={t("login.code")}>
                {(props) => (
                  <Input
                    {...props}
                    ref={codeRef}
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    name="one-time-code"
                    value={code}
                    onChange={(e) => onCodeChange(e.target.value)}
                    className="text-center font-mono text-2xl tracking-[0.5em]"
                    aria-busy={busy === "verify" || undefined}
                    required
                  />
                )}
              </Field>
              <Button type="submit" loading={busy === "verify"} disabled={code.length !== 6} disabledReason={t("disabled.needCode")}>
                {busy === "verify" ? t("login.verifying") : t("login.verify")}
              </Button>
              <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
                <button type="button" onClick={changeEmail} className="min-h-11 font-medium text-primary underline-offset-4 hover:underline">
                  {t("login.changeEmail")}
                </button>
                {resendIn > 0 ? (
                  <span className="text-muted" aria-live="polite">
                    {t("login.resendIn", { seconds: resendIn })}
                  </span>
                ) : (
                  <button type="button" onClick={() => requestCode()} disabled={busy === "send"} className="min-h-11 font-medium text-primary underline-offset-4 hover:underline">
                    {busy === "send" ? t("login.sending") : t("login.resend")}
                  </button>
                )}
              </div>
            </form>
          )}
        </>
      )}
      {providers && !providers.email && !providers.google && !providers.apple && <Alert tone="error">{t("login.emailUnavailable")}</Alert>}
      <p className="text-xs text-muted">{t("login.terms")}</p>
    </div>
  );
}
