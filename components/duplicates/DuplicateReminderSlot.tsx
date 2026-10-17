import { cookies } from "next/headers";
import { getSession } from "@/lib/auth-helpers";
import { duplicateReminder } from "@/lib/data/duplicates";
import { DuplicateReminder } from "./DuplicateReminder";
import { SNOOZE_COOKIE, isSnoozed } from "./snooze";

/**
 * Server half of the reminder: decides whether there is anything to say.
 *
 * Mount it once in the panel shell. It renders `null` far more often than it
 * renders anything, and the cheap answers are checked first:
 *
 *  1. "not now" still holding (a cookie read, no query),
 *  2. no session (nothing to count),
 *  3. under both thresholds.
 *
 * Only case 3 costs a database round trip, and it is one grouped index scan
 * over one account's rows - `duplicateReminderQuery` returns a single row and
 * never touches the uploads table twice. That matters because this runs on
 * every panel page load: the full scan, which fetches the files themselves,
 * stays on /dashboard/duplicates where somebody asked for it.
 *
 * A failure here must not take the panel down with it. There is no version of
 * "we could not count your duplicates" that justifies a 500 on the dashboard,
 * so the reminder simply does not appear.
 *
 * `userId` is optional so this can be dropped in anywhere, but pass it when the
 * caller already has a session (the panel layout does): it saves this component
 * asking Better Auth for the same session a second time on every page load.
 */
export async function DuplicateReminderSlot({ userId }: { userId?: string } = {}) {
  const jar = await cookies();
  // Cheapest answer first: a snooze costs a cookie read and no query at all.
  if (isSnoozed(jar.get(SNOOZE_COOKIE)?.value, Date.now())) return null;

  const owner = userId ?? (await getSession())?.user.id;
  if (!owner) return null;

  try {
    const state = await duplicateReminder(owner);
    if (!state.due) return null;
    return <DuplicateReminder redundant={state.redundant} reclaimable={state.reclaimable} />;
  } catch (err) {
    console.error("[duplicates] reminder failed:", err);
    return null;
  }
}
