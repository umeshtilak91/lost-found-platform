import { redirect } from "next/navigation";

// Old prototype detail URL (/item/:id) kept working.
export default async function LegacyItemRedirect({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  redirect(`/items/${encodeURIComponent(id)}`);
}
