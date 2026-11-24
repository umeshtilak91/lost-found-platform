import { EmptyState, LinkButton } from "@/components/ui";
import { getT } from "@/lib/i18n/server";

export default async function NotFound() {
  const { t } = await getT();
  return <EmptyState title={t("notFound.title")} body={t("notFound.body")} action={<LinkButton href="/">{t("notFound.home")}</LinkButton>} />;
}
