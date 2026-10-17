import "server-only";
import { headers } from "next/headers";
import { db } from "@/lib/db";
import { auditLog } from "@/lib/db/schema";
import { clientIp } from "@/lib/password";

/**
 * Write one entry to `audit_log`.
 *
 * Runs AFTER the change it describes, so a failure here must not throw: the
 * password really has been reset by then, and reporting the whole operation as
 * failed would be a lie that invites the operator to do it twice. A missing log
 * line is a problem for tomorrow; a confused admin is a problem right now.
 *
 * `action` lands in a varchar(64), so names stay short and dotted:
 * `admin.user.email_verified`, `mail.test_sent`, `admin.upload.deleted`.
 */
export async function recordAudit(
  actorId: string,
  action: string,
  detail: Record<string, unknown>,
): Promise<void> {
  try {
    await db.insert(auditLog).values({
      userId: actorId,
      action,
      detail,
      ip: clientIp(await headers()),
    });
  } catch (err) {
    console.error(`[audit] could not record ${action}:`, err);
  }
}
