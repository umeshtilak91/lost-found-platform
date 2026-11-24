"use client";

import { useEffect } from "react";
import { Button, EmptyState } from "@/components/ui";
import { useI18n } from "@/lib/i18n/client";

export default function ErrorPage({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const { t } = useI18n();
  useEffect(() => {
    console.error(error.digest ?? error.message);
  }, [error]);
  return <EmptyState title={t("common.error")} action={<Button onClick={reset}>{t("common.retry")}</Button>} />;
}
