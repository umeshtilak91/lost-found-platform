import type { Metadata } from "next";
import { Suspense } from "react";
import { Card, Spinner } from "@/components/ui";
import { getT } from "@/lib/i18n/server";
import { LoginForm } from "./LoginForm";

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await getT();
  return { title: t("login.title"), robots: { index: false } };
}

export default async function LoginPage() {
  const { t } = await getT();
  return (
    <div className="mx-auto max-w-md">
      <Card>
        <h1 className="text-2xl font-bold">{t("login.title")}</h1>
        <p className="mb-6 mt-1 text-sm text-muted">{t("login.subtitle")}</p>
        <Suspense fallback={<Spinner label={t("common.loading")} />}>
          <LoginForm />
        </Suspense>
      </Card>
    </div>
  );
}
