import {
  pgTable,
  text,
  varchar,
  integer,
  bigint,
  timestamp,
  primaryKey,
} from "drizzle-orm/pg-core";
import { user } from "./auth-schema";

/**
 * duplicate_dismissals - "these copies are meant to exist, stop counting them".
 *
 * The retroactive scan (lib/data/duplicates.ts) is a tool the owner opens on
 * purpose. The REMINDER is the opposite: it speaks without being asked, so it
 * needs a way to be told no that actually holds. This table is that no.
 *
 * ## Why the key is (owner_id, checksum)
 *
 * A dismissal is a statement about BYTES, not about rows, and the key has to be
 * the same thing the statement is about. Three consequences follow, and each of
 * them is a bug that keying on `uploads.id` would have:
 *
 *  - **Deleting one copy must not revive the reminder for the rest.** A set of
 *    four copies keyed by id is four rows; trash one and the survivors form a
 *    trio nobody ever dismissed, so the nag comes back for exactly the thing the
 *    user just settled. Keyed by checksum the set keeps its identity however
 *    many copies come and go.
 *  - **Re-uploading the same file must not resurrect it.** ShareX sends the same
 *    screenshot again and a new row appears with a new id but the same sha256.
 *    An id-keyed dismissal would treat it as a stranger; this one does not.
 *  - **The scan groups by checksum**, so a dismissal keyed any other way could
 *    only ever be translated back into a group by guessing. The set and the
 *    permission to ignore it are then the same shape, and "is this group
 *    dismissed" is a primary key probe rather than a join over ids.
 *
 * `owner_id` leads the key because a checksum is a GLOBAL fact about bytes. A
 * dismissal stored without an owner would let one account silence another
 * account's reminder, and - worse - answer "has anybody here dismissed these
 * bytes", which is the same ownership oracle lib/upload/duplicate-lookup.ts
 * exists to avoid. Per owner, always.
 *
 * The composite primary key doubles as the index every read wants: the scan and
 * the reminder both probe (owner_id, checksum), which is the key in order, and a
 * table this small has no business carrying a second index.
 *
 * The barrel (lib/db/schema/index.ts) re-exports this file, so the table reaches
 * both drizzle() and Better Auth's adapter through the same object as every
 * other table. drizzle-kit would have picked it up either way, because
 * drizzle.config.ts points at the whole directory rather than at the barrel.
 */
export const duplicateDismissals = pgTable(
  "duplicate_dismissals",
  {
    ownerId: text("owner_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),

    /** sha256 hex, exactly as `uploads.checksum` stores it (lower case, 64 chars). */
    checksum: varchar("checksum", { length: 64 }).notNull(),

    /**
     * What the set looked like when it was waved off.
     *
     * A note, never an input to a decision: the scan always recounts, because
     * copies are added and trashed after the fact and a stored count would go
     * stale the moment it was written. It exists so the page can say "you kept
     * 4 copies of this on 3 March" instead of showing a bare checksum.
     */
    copies: integer("copies").notNull().default(0),
    bytes: bigint("bytes", { mode: "number" }).notNull().default(0),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.ownerId, t.checksum] })],
);

export type DuplicateDismissal = typeof duplicateDismissals.$inferSelect;
