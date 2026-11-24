import type { Metadata } from "next";
import { ItemForm } from "@/features/items/ItemForm";
import { RequireAuth } from "@/features/auth/RequireAuth";
import { PageHeader } from "@/components/ui";
import { getT } from "@/lib/i18n/server";

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await getT();
  return { title: t("form.title.create"), robots: { index: false } };
}

export default async function ReportPage({ searchParams }: { searchParams: Promise<{ type?: string }> }) {
  const { t } = await getT();
  const { type } = await searchParams;
  return (
    <div className="mx-auto max-w-2xl">
      <PageHeader title={t("form.title.create")} />
      <RequireAuth message="form.signIn">
        <ItemForm defaultType={type === "found" ? "found" : "lost"} />
      </RequireAuth>
    </div>
  );
}
