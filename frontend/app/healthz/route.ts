// Liveness probe for the web tier (no API dependency).
export const dynamic = "force-dynamic";

export function GET() {
  return Response.json({ status: "ok" });
}
