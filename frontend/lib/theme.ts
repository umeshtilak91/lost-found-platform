import "server-only";
import { cookies } from "next/headers";
import type { Theme } from "@/components/layout/ThemeToggle";

export const DEFAULT_THEME: Theme = "dark";

export async function getTheme(): Promise<Theme> {
  const value = (await cookies()).get("lf_theme")?.value;
  return value === "light" || value === "dark" ? value : DEFAULT_THEME;
}
