import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { getStorage } from "@/lib/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Liveness/readiness probe for the container healthcheck and for host-side
 * alerting.
 *
 * Deliberately checks the two dependencies that can fail independently of the
 * process still being alive — a Node server that answers HTTP while its database
 * is unreachable is exactly the "silently broken" state a healthcheck exists to
 * catch. Returns 503 so Docker and any uptime monitor treat it as down.
 *
 * Reveals nothing useful to an anonymous caller: no versions, no paths, no
 * connection strings — just which subsystem is unhappy.
 */
export async function GET(): Promise<Response> {
  const checks: Record<string, "ok" | "fail"> = {};

  try {
    await db.execute(sql`select 1`);
    checks.database = "ok";
  } catch {
    checks.database = "fail";
  }

  try {
    // Cheap, read-only: proves the storage driver answers and its root is
    // reachable, without touching user data. `stat` resolves to null for a
    // missing key, so a null here is a healthy answer — only a thrown error
    // (unmounted volume, dead S3 endpoint) means trouble.
    await getStorage().stat("__healthcheck__");
    checks.storage = "ok";
  } catch {
    checks.storage = "fail";
  }

  const healthy = Object.values(checks).every((v) => v === "ok");

  return Response.json(
    { status: healthy ? "ok" : "degraded", checks },
    {
      status: healthy ? 200 : 503,
      headers: { "Cache-Control": "no-store" },
    },
  );
}
