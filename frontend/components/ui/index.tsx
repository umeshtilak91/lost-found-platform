import Link from "next/link";
import clsx from "clsx";
import { forwardRef, useId } from "react";
import { AlertCircle, CheckCircle2, Info, Loader2 } from "lucide-react";

type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
const buttonBase =
  "group/btn inline-flex items-center justify-center gap-2 rounded-lg px-4 py-2.5 text-sm font-semibold transition-[color,background-color,border-color,transform,box-shadow] duration-150 active:translate-y-px active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-60 disabled:active:translate-y-0 disabled:active:scale-100 min-h-11";
const buttonVariants: Record<ButtonVariant, string> = {
  primary: "bg-primary text-primary-contrast shadow-sm hover:bg-primary-hover hover:shadow-md",
  secondary: "border border-border bg-surface text-text hover:border-primary/60 hover:bg-surface-muted",
  ghost: "text-text hover:bg-surface-muted",
  danger: "bg-lost text-white hover:opacity-90 dark:text-black",
};

export const Button = forwardRef<
  HTMLButtonElement,
  React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; loading?: boolean; disabledReason?: string }
>(function Button({ variant = "primary", loading, className, children, disabled, disabledReason, title, ...props }, ref) {
  // A disabled button explains itself on hover (title) and to screen readers.
  const reason = disabled && !loading ? disabledReason : undefined;
  return (
    <button
      ref={ref}
      className={clsx(buttonBase, buttonVariants[variant], className)}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      title={reason ?? title}
      {...props}
    >
      {loading && <Loader2 className="size-4 animate-spin" aria-hidden />}
      {children}
      {reason && <span className="sr-only"> ({reason})</span>}
    </button>
  );
});

export function LinkButton({
  href,
  variant = "primary",
  className,
  children,
  ...props
}: React.ComponentProps<typeof Link> & { variant?: ButtonVariant }) {
  return (
    <Link href={href} className={clsx(buttonBase, buttonVariants[variant], className)} {...props}>
      {children}
    </Link>
  );
}

export function Field({
  label,
  hint,
  error,
  optional,
  children,
  optionalLabel = "optional",
}: {
  label: string;
  hint?: string;
  error?: string;
  optional?: boolean;
  optionalLabel?: string;
  children: (props: { id: string; "aria-describedby"?: string; "aria-invalid"?: boolean }) => React.ReactNode;
}) {
  const id = useId();
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [hintId, errorId].filter(Boolean).join(" ") || undefined;
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-sm font-medium">
        {label}
        {optional && <span className="ml-1 font-normal text-muted">({optionalLabel})</span>}
      </label>
      {children({ id, "aria-describedby": describedBy, "aria-invalid": error ? true : undefined })}
      {hint && (
        <p id={hintId} className="text-xs text-muted">
          {hint}
        </p>
      )}
      {error && (
        <p id={errorId} className="flex items-center gap-1 text-sm text-lost">
          <AlertCircle className="size-4 shrink-0" aria-hidden />
          {error}
        </p>
      )}
    </div>
  );
}

const control =
  "w-full rounded-lg border border-border bg-surface px-3 py-2.5 text-base text-text placeholder:text-muted aria-[invalid=true]:border-lost min-h-11";

export const Input = forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(function Input(
  { className, ...props },
  ref
) {
  return <input ref={ref} className={clsx(control, className)} {...props} />;
});

export const Textarea = forwardRef<HTMLTextAreaElement, React.TextareaHTMLAttributes<HTMLTextAreaElement>>(
  function Textarea({ className, ...props }, ref) {
    return <textarea ref={ref} className={clsx(control, "min-h-24", className)} {...props} />;
  }
);

export const Select = forwardRef<HTMLSelectElement, React.SelectHTMLAttributes<HTMLSelectElement>>(function Select(
  { className, ...props },
  ref
) {
  return <select ref={ref} className={clsx(control, className)} {...props} />;
});

type Tone = "error" | "success" | "info" | "warn";
const toneStyles: Record<Tone, string> = {
  error: "border-lost/40 bg-lost-bg text-lost",
  success: "border-found/40 bg-found-bg text-found",
  info: "border-primary/30 bg-info-bg text-text",
  warn: "border-warn/40 bg-warn-bg text-warn",
};
const toneIcons = { error: AlertCircle, success: CheckCircle2, info: Info, warn: AlertCircle };

export function Alert({ tone = "info", children, className }: { tone?: Tone; children: React.ReactNode; className?: string }) {
  const Icon = toneIcons[tone];
  return (
    <div
      role={tone === "error" ? "alert" : "status"}
      className={clsx("flex items-start gap-2 rounded-lg border px-3 py-2.5 text-sm", toneStyles[tone], className)}
    >
      <Icon className="mt-0.5 size-4 shrink-0" aria-hidden />
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

export function Spinner({ label }: { label: string }) {
  return (
    <div role="status" className="flex items-center gap-2 py-8 text-muted">
      <Loader2 className="size-5 animate-spin" aria-hidden />
      <span>{label}</span>
    </div>
  );
}

export function Card({ className, children, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={clsx("rounded-xl border border-border bg-surface p-4 sm:p-6", className)} {...props}>
      {children}
    </div>
  );
}

export function EmptyState({ title, body, action }: { title: string; body?: string; action?: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-dashed border-border bg-surface px-6 py-12 text-center">
      <h2 className="text-lg font-semibold">{title}</h2>
      {body && <p className="mx-auto mt-2 max-w-md text-sm text-muted">{body}</p>}
      {action && <div className="mt-4 flex justify-center">{action}</div>}
    </div>
  );
}

export function Badge({ tone = "neutral", children }: { tone?: "lost" | "found" | "neutral" | "warn" | "success"; children: React.ReactNode }) {
  const styles = {
    lost: "bg-lost-bg text-lost",
    found: "bg-found-bg text-found",
    neutral: "bg-surface-muted text-muted",
    warn: "bg-warn-bg text-warn",
    success: "bg-found-bg text-found",
  };
  return <span className={clsx("inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold", styles[tone])}>{children}</span>;
}

export function PageHeader({ title, children }: { title: string; children?: React.ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
      <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">{title}</h1>
      {children}
    </div>
  );
}
