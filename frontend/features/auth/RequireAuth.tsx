"use client";

import { usePathname } from "next/navigation";
import { useAuth } from "@/features/auth/AuthProvider";
import { Card, LinkButton } from "@/components/ui";
import { PanelSkeleton } from "@/components/ui/Skeleton";
import { useI18n } from "@/lib/i18n/client";
import type { MessageKey } from "@/lib/i18n/messages";

// Client-side gate for signed-in pages. The API enforces authorization; this
// only decides what to render.
export function RequireAuth({ children, message = "common.signInRequired" }: { children: React.ReactNode; message?: MessageKey }) {
  const { user, loading } = useAuth();
  const { t } = useI18n();
  const pathname = usePathname();
  if (loading) return <PanelSkeleton label={t("common.loading")} />;
  if (!user) {
    return (
      <Card className="mx-auto max-w-md text-center">
        <p>{t(message)}</p>
        <LinkButton href={`/login?next=${encodeURIComponent(pathname)}`} className="mt-4">
          {t("nav.signIn")}
        </LinkButton>
      </Card>
    );
  }
  return <>{children}</>;
}
