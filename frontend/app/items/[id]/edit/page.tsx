import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ItemForm } from "@/features/items/ItemForm";
import { RequireAuth } from "@/features/auth/RequireAuth";
import { Alert, PageHeader } from "@/components/ui";
import { serverApi } from "@/lib/server-api";
import { getT } from "@/lib/i18n/server";
import type { Item, Viewer } from "@/lib/types";

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await getT();
  return { title: t("form.title.edit"), robots: { index: false } };
}

export default async function EditItemPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { t } = await getT();
  if (!/^\d{1,12}$/.test(id)) notFound();
  const result = await serverApi<{ item: Item; viewer: Viewer }>(`/items/${id}`);
  if (!result.ok && (result.status === 404 || result.status === 410)) notFound();
  return (
    <div className="mx-auto max-w-2xl">
      <PageHeader title={t("form.title.edit")} />
      <RequireAuth>
        {!result.ok ? (
          <Alert tone="error">{t("common.error")}</Alert>
        ) : !result.data.viewer.isOwner ? (
          <Alert tone="error">{t("common.signInRequired")}</Alert>
        ) : (
          <ItemForm item={result.data.item} />
        )}
      </RequireAuth>
    </div>
  );
}
