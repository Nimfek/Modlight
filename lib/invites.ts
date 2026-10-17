import "server-only";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { and, eq, gt, like } from "drizzle-orm";
import { db } from "@/lib/db";
import { user as users, verification } from "@/lib/db/schema";
import { writeCredentialPassword } from "@/lib/credentials";

/**
 * Invitations for accounts an administrator creates.
 *
 * Why a token of our own rather than reusing the password-reset link: the reset
 * mail says "somebody asked to reset your password", and a person who has never
 * had an account on this site has no password to reset. The wording of a
 * transactional email is not decoration, it is the only context the recipient
 * gets, and one that describes the wrong event trains people to click links
 * they do not understand.
 *
 * Stored in Better Auth's `verification` table, which was empty and is exactly
 * the right shape (identifier, value, expiry). The identifier carries the token
 * HASH so the lookup is the indexed one, and the value carries the user id.
 * Storing the raw token would mean a database read is enough to take over every
 * pending account.
 */

const PREFIX = "invite:";
const TTL_MS = 7 * 24 * 60 * 60 * 1000;

function digest(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * Mint an invitation for `userId`, replacing any earlier one.
 *
 * Replacing rather than adding is what makes "resend the invitation" safe: two
 * live tokens for one account would mean revoking an invitation is impossible
 * without knowing how many were issued.
 */
export async function createInvite(userId: string): Promise<string> {
  await revokeInvites(userId);

  const token = randomBytes(32).toString("base64url");
  const now = new Date();
  await db.insert(verification).values({
    id: randomUUID(),
    identifier: PREFIX + digest(token),
    value: userId,
    expiresAt: new Date(now.getTime() + TTL_MS),
    createdAt: now,
    updatedAt: now,
  });
  return token;
}

export async function revokeInvites(userId: string): Promise<void> {
  await db
    .delete(verification)
    .where(and(like(verification.identifier, `${PREFIX}%`), eq(verification.value, userId)));
}

/** Is there a live invitation for this account? Drives the "Invited" badge. */
export async function hasPendingInvite(userId: string): Promise<boolean> {
  const [row] = await db
    .select({ expiresAt: verification.expiresAt })
    .from(verification)
    .where(and(like(verification.identifier, `${PREFIX}%`), eq(verification.value, userId)))
    .limit(1);
  return Boolean(row && row.expiresAt.getTime() > Date.now());
}

/**
 * Every account with a live invitation, in one query.
 *
 * The user table is drawn as a list, so asking `hasPendingInvite` per row would
 * be one round trip per account for a badge. The set is small by nature: a
 * pending invitation is deleted the moment it is accepted.
 */
export async function pendingInviteUserIds(): Promise<Set<string>> {
  const rows = await db
    .select({ userId: verification.value })
    .from(verification)
    .where(
      and(like(verification.identifier, `${PREFIX}%`), gt(verification.expiresAt, new Date())),
    );
  return new Set(rows.map((r) => r.userId));
}

export interface InviteSubject {
  userId: string;
  email: string;
  name: string;
}

/** Resolve a token without consuming it, so the page can be rendered first. */
export async function readInvite(token: string): Promise<InviteSubject | null> {
  if (!token) return null;

  const [row] = await db
    .select({ id: verification.id, userId: verification.value, expiresAt: verification.expiresAt })
    .from(verification)
    .where(eq(verification.identifier, PREFIX + digest(token)))
    .limit(1);
  if (!row) return null;

  if (row.expiresAt.getTime() <= Date.now()) {
    await db.delete(verification).where(eq(verification.id, row.id));
    return null;
  }

  const [account] = await db
    .select({ id: users.id, email: users.email, name: users.name })
    .from(users)
    .where(eq(users.id, row.userId))
    .limit(1);
  if (!account) {
    // The account was deleted between the invitation and the click.
    await db.delete(verification).where(eq(verification.id, row.id));
    return null;
  }

  return { userId: account.id, email: account.email, name: account.name };
}

export type AcceptInviteResult =
  | { ok: true; userId: string; email: string }
  | { ok: false; reason: "invalid" | "weak-password" };

export const INVITE_PASSWORD_MIN = 8;

/**
 * Set the password the invitation was for, and mark the address confirmed.
 *
 * Confirming the address here is not a shortcut: the invitation was delivered
 * to that mailbox and the token proves the recipient read it, which is a
 * stronger demonstration than the confirmation mail would have been.
 */
export async function acceptInvite(token: string, password: string): Promise<AcceptInviteResult> {
  if (!password || password.length < INVITE_PASSWORD_MIN) {
    return { ok: false, reason: "weak-password" };
  }

  const subject = await readInvite(token);
  if (!subject) return { ok: false, reason: "invalid" };

  await writeCredentialPassword(subject.userId, password);
  await db.update(users).set({ emailVerified: true }).where(eq(users.id, subject.userId));
  await revokeInvites(subject.userId);

  return { ok: true, userId: subject.userId, email: subject.email };
}
