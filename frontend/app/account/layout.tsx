import type { Metadata } from "next";

// Private, per-user page: never indexed.
export const metadata: Metadata = { robots: { index: false, follow: false } };

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
