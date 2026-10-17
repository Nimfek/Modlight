"use server";

/**
 * Destructive administration.
 *
 * Every action here re-checks the admin role on the server. The panel hides
 * these controls from everyone else, but a Server Action is a public POST
 * endpoint — the UI is never the authorisation boundary. The two that destroy
 * bytes (account deletion, orphan purge) additionally refuse to act on
 * ambiguous input rather than guessing.
 */

import { randomBytes } from "node:crypto";
import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { and, eq, inArray, isNull, notInArray, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { account, uploads, user as users } from "@/lib/db/schema";
import { auth } from "@/lib/auth";
import { headersWithoutSession, requireAdmin } from "@/lib/auth-helpers";
import { recordAudit } from "@/lib/audit";
import { writeCredentialPassword } from "@/lib/credentials";
import { createInvite, hasPendingInvite, revokeInvites } from "@/lib/invites";
import { mailReady } from "@/lib/mail-settings";
import { sendMail } from "@/lib/mail";
import {
  pickMailLocale,
  renderAccountInvited,
  renderEmailChanged,
  renderPasswordChanged,
} from "@/lib/mail-templates";
import { config } from "@/lib/config";
import { deleteMediaBulk, deleteMediaHard } from "@/lib/media/actions";
import { confirmationMatches } from "@/components/admin/confirm";
import { UNLIMITED_QUOTA } from "@/lib/quota";
import { avatarUrl } from "@/lib/avatar";
import {
  EMAIL_PATTERN,
  PASSWORD_MAX,
  PASSWORD_MIN,
  USERNAME_PATTERN,
  type AdminUserDetail,
} from "@/lib/admin-users";
import { setUserTag, type TagIssue } from "@/app/actions/account";
import {
  listOrphans,
  orphanSummary,
  recalculateAllQuotas,
  scanStorageOrphans,
  userDeletionImpact,
  type OrphanRow,
  type OrphanSummary,
  type QuotaRecalcResult,
  type StorageScanResult,
  type UserDeletionImpact,
} from "@/lib/data/admin";

// ---------------------------------------------------------------------------
// Orphaned files
// ---------------------------------------------------------------------------

export interface OrphanOverview {
  summary: OrphanSummary;
  items: OrphanRow[];
}

export async function loadOrphans(): Promise<OrphanOverview> {
  await requireAdmin();
  const [summary, items] = await Promise.all([orphanSummary(), listOrphans()]);
  return { summary, items };
}

/**
 * Purge one orphan. The `owner_id IS NULL` predicate is part of the WHERE, not
 * a pre-flight check: it is what guarantees a stale id from a browser tab left
 * open cannot delete a file that has since been re-homed to a real account.
 */
export async function deleteOrphan(id: string): Promise<{ ok: boolean }> {
  await requireAdmin();
  if (!id) return { ok: false };

  const [row] = await db
    .select({
      id: uploads.id,
      ownerId: uploads.ownerId,
      size: uploads.size,
      storageKey: uploads.storageKey,
      thumbKey: uploads.thumbKey,
    })
    .from(uploads)
    .where(and(eq(uploads.id, id), isNull(uploads.ownerId)))
    .limit(1);
  if (!row) return { ok: false };

  await deleteMediaHard(row);
  revalidatePath("/dashboard/admin");
  return { ok: true };
}

export interface PurgeResult {
  ok: boolean;
  /** Set when the typed confirmation did not match the current count. */
  reason?: "confirmation" | "empty";
  deleted: number;
  bytes: number;
  /** Rows storage refused to release; they stay for the next attempt. */
  failed: number;
}

/**
 * Purge EVERY orphan. Irreversible, so it is gated twice:
 *
 *  1. the admin retypes the exact file count, and
 *  2. that count is re-read from the database here — if it moved between the
 *     dialog opening and the click (a sweep ran, another admin acted), the
 *     confirmation no longer matches and nothing happens.
 *
 * The second gate is the one that matters: a stale number in a browser tab is
 * not informed consent.
 */
export async function purgeAllOrphans(confirmation: string): Promise<PurgeResult> {
  await requireAdmin();

  const rows = await db
    .select({
      id: uploads.id,
      ownerId: uploads.ownerId,
      size: uploads.size,
      storageKey: uploads.storageKey,
      thumbKey: uploads.thumbKey,
    })
    .from(uploads)
    .where(isNull(uploads.ownerId));

  if (rows.length === 0) return { ok: false, reason: "empty", deleted: 0, bytes: 0, failed: 0 };
  if (!confirmationMatches(confirmation, rows.length)) {
    return { ok: false, reason: "confirmation", deleted: 0, bytes: 0, failed: 0 };
  }

  const result = await deleteMediaBulk(rows);
  revalidatePath("/dashboard/admin");
  return { ok: true, ...result };
}

// ---------------------------------------------------------------------------
// Account editing
//
// The admin role is re-checked in every function below. The panel hides these
// controls from everyone else, but a Server Action is a public POST endpoint —
// the UI is never the authorisation boundary.
// ---------------------------------------------------------------------------

/**
 * Send a courtesy notification, never letting it fail the operation it follows.
 *
 * "Your password was changed" is the only signal a user gets that somebody else
 * took over their account, so it is worth sending. It is not worth failing an
 * administrative action over: by the time it goes out, the password is already
 * changed, and an exception here would report a completed change as a failure.
 */
async function notify(
  to: string,
  message: { subject: string; html: string; text: string },
): Promise<void> {
  try {
    if (!(await mailReady())) return;
    await sendMail({ to, subject: message.subject, html: message.html, text: message.text });
  } catch (err) {
    console.error("[mail] notification not delivered:", err);
  }
}

/** Language for a message to `user`. Falls back to the request's own header. */
async function mailLocaleFor(locale: string | null | undefined) {
  return pickMailLocale(locale ?? null, (await headers()).get("accept-language"));
}

/**
 * Everything the edit form needs about one account, read fresh.
 *
 * Not folded into the table query: the dialog opens minutes or hours after the
 * list was fetched, and editing a stale snapshot is how two admins overwrite
 * each other without either of them noticing.
 */
export async function loadUserDetail(userId: string): Promise<AdminUserDetail | null> {
  await requireAdmin();
  if (!userId) return null;

  const [row] = await db
    .select({
      id: users.id,
      name: users.name,
      email: users.email,
      emailVerified: users.emailVerified,
      username: users.username,
      role: users.role,
      banned: users.banned,
      createdAt: users.createdAt,
      tag: users.userCode,
      image: users.image,
      usedQuota: users.usedQuota,
      maxQuota: users.maxQuota,
      allowRootShortLinks: users.allowRootShortLinks,
      publicProfile: users.publicProfile,
      skipTagInUrl: users.skipTagInUrl,
      twoFactorEnabled: users.twoFactorEnabled,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!row) return null;

  const [counts] = await db
    .select({ files: sql<number>`count(*)::int` })
    .from(uploads)
    .where(and(eq(uploads.ownerId, userId), isNull(uploads.deletedAt)));

  const [cred] = await db
    .select({ password: account.password })
    .from(account)
    .where(and(eq(account.userId, userId), eq(account.providerId, "credential")))
    .limit(1);

  const invitePending = await hasPendingInvite(userId);

  return {
    id: row.id,
    name: row.name,
    email: row.email,
    emailVerified: row.emailVerified ?? false,
    username: row.username ?? null,
    role: row.role ?? null,
    banned: row.banned ?? false,
    createdAt: row.createdAt ? row.createdAt.toISOString() : null,
    tag: row.tag ?? null,
    avatar: avatarUrl(row.tag, row.image),
    usedQuota: Number(row.usedQuota ?? 0),
    maxQuota: Number(row.maxQuota ?? UNLIMITED_QUOTA),
    files: Number(counts?.files ?? 0),
    allowRootShortLinks: row.allowRootShortLinks ?? false,
    publicProfile: row.publicProfile ?? false,
    skipTagInUrl: row.skipTagInUrl ?? false,
    twoFactorEnabled: row.twoFactorEnabled ?? false,
    // A row with a NULL password is an invitation that has not been accepted:
    // `createAccount` strips the throwaway credential it had to create.
    hasPassword: Boolean(cred?.password),
    invitePending,
  };
}

/** Fields the admin form may write. Anything omitted is left exactly as it is. */
export interface UpdateUserPatch {
  name?: string;
  /** Empty string clears the login name. */
  username?: string | null;
  email?: string;
  /** `user.userCode` — the first segment of every public link. */
  tag?: string;
  /** A new password. Never a current one: there is no current one to read. */
  newPassword?: string;
  /** Byte limit; anything negative means unlimited. */
  maxQuota?: number;
  role?: "admin" | "user";
  banned?: boolean;
  allowRootShortLinks?: boolean;
  publicProfile?: boolean;
  skipTagInUrl?: boolean;
}

/** What the form changed, so the confirmation can name it rather than say "saved". */
export type UserChange =
  | "name"
  | "username"
  | "email"
  | "tag"
  | "password"
  | "quota"
  | "role"
  | "banned"
  | "permissions";

/**
 * Why a field was refused. Travels as data, never as a thrown message: Next
 * masks the message of an error raised inside a Server Action in production, so
 * anything the operator has to read would arrive as "An error occurred".
 */
export type UserFieldIssue =
  | { field: "name"; reason: "empty" }
  | { field: "username"; reason: "charset" | "taken" }
  | { field: "email"; reason: "invalid" | "taken" }
  | { field: "tag"; reason: TagIssue }
  | { field: "password"; reason: "too-short" | "too-long" }
  | { field: "quota"; reason: "invalid" }
  | { field: "role"; reason: "self" }
  | { field: "banned"; reason: "self" };

export type UpdateUserResult =
  | {
      ok: true;
      changed: UserChange[];
      /** True when the password change ended the account's other sessions. */
      sessionsRevoked: boolean;
      /** The account as it reads AFTER the write, for the confirmation. */
      name: string;
      email: string;
    }
  | { ok: false; reason: "not-found" }
  | { ok: false; reason: "invalid"; issues: UserFieldIssue[] };

/**
 * Edit an account from the admin panel.
 *
 * Two rules shape the whole function:
 *
 *  1. **Everything is validated before anything is written.** A form with eight
 *     fields fails on one of them often enough that "half the account was
 *     updated, work out which half" is not an acceptable outcome. The single
 *     exception is the tag, whose uniqueness can only be settled by the write
 *     itself — so it goes first, and a lost race returns before any other
 *     column is touched.
 *
 *  2. **An admin may not disarm themselves.** Demoting or banning the account
 *     you are signed in with is how an install ends up with nobody who can
 *     administer it, so both are refused here (Better Auth refuses the self-ban
 *     too — this is the near guard, not the only one).
 *
 * Changing an email address or a password is logged to `audit_log`: those two
 * are the ones that hand over control of an account, and "who did this and
 * when" has to survive the session that did it.
 */
export async function updateUserAccount(
  userId: string,
  patch: UpdateUserPatch,
): Promise<UpdateUserResult> {
  const session = await requireAdmin();
  if (!userId) return { ok: false, reason: "not-found" };

  const [target] = await db
    .select({
      id: users.id,
      name: users.name,
      email: users.email,
      username: users.username,
      role: users.role,
      banned: users.banned,
      tag: users.userCode,
      maxQuota: users.maxQuota,
      allowRootShortLinks: users.allowRootShortLinks,
      publicProfile: users.publicProfile,
      skipTagInUrl: users.skipTagInUrl,
      locale: users.locale,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!target) return { ok: false, reason: "not-found" };

  const isSelf = target.id === session.user.id;
  const issues: UserFieldIssue[] = [];
  const changed: UserChange[] = [];

  // ── Validate ────────────────────────────────────────────────────────────
  const columns: Partial<typeof users.$inferInsert> = {};

  if (patch.name !== undefined) {
    const next = patch.name.trim().slice(0, 120);
    if (!next) issues.push({ field: "name", reason: "empty" });
    else if (next !== target.name) {
      columns.name = next;
      changed.push("name");
    }
  }

  if (patch.username !== undefined) {
    const next = (patch.username ?? "").trim() || null;
    if (next !== (target.username ?? null)) {
      if (next && !USERNAME_PATTERN.test(next)) {
        issues.push({ field: "username", reason: "charset" });
      } else if (next && (await nameTaken(users.username, next, userId))) {
        // Case-insensitive: sign-in resolves a username with `lower(...)`, so
        // `Ada` and `ada` would be the same login for two different accounts.
        issues.push({ field: "username", reason: "taken" });
      } else {
        columns.username = next;
        changed.push("username");
      }
    }
  }

  let previousEmail: string | null = null;
  if (patch.email !== undefined) {
    const next = patch.email.trim().toLowerCase();
    if (!EMAIL_PATTERN.test(next) || next.length > 254) {
      issues.push({ field: "email", reason: "invalid" });
    } else if (next !== target.email.toLowerCase()) {
      if (await nameTaken(users.email, next, userId)) {
        issues.push({ field: "email", reason: "taken" });
      } else {
        previousEmail = target.email;
        columns.email = next;
        // The admin is asserting this address. Leaving it unverified would lock
        // the account out on installs that require verification to sign in,
        // which turns "fix my email" into "lose my account".
        columns.emailVerified = true;
        changed.push("email");
      }
    }
  }

  const newPassword = patch.newPassword?.length ? patch.newPassword : null;
  if (newPassword) {
    if (newPassword.length < PASSWORD_MIN) issues.push({ field: "password", reason: "too-short" });
    else if (newPassword.length > PASSWORD_MAX) issues.push({ field: "password", reason: "too-long" });
  }

  if (patch.maxQuota !== undefined) {
    const raw = patch.maxQuota;
    if (!Number.isFinite(raw) || !Number.isSafeInteger(Math.round(raw))) {
      issues.push({ field: "quota", reason: "invalid" });
    } else {
      const value = raw < 0 ? UNLIMITED_QUOTA : Math.round(raw);
      if (value !== Number(target.maxQuota ?? UNLIMITED_QUOTA)) {
        columns.maxQuota = value;
        changed.push("quota");
      }
    }
  }

  const nextRole = patch.role;
  const roleChanged = nextRole !== undefined && nextRole !== (target.role ?? "user");
  if (roleChanged && isSelf) issues.push({ field: "role", reason: "self" });

  const nextBanned = patch.banned;
  const banChanged = nextBanned !== undefined && nextBanned !== (target.banned ?? false);
  if (banChanged && isSelf) issues.push({ field: "banned", reason: "self" });

  // Permission flags: booleans, nothing to reject.
  let permissionsChanged = false;
  if (patch.allowRootShortLinks !== undefined &&
      patch.allowRootShortLinks !== (target.allowRootShortLinks ?? false)) {
    columns.allowRootShortLinks = patch.allowRootShortLinks;
    permissionsChanged = true;
  }
  if (patch.publicProfile !== undefined &&
      patch.publicProfile !== (target.publicProfile ?? false)) {
    columns.publicProfile = patch.publicProfile;
    permissionsChanged = true;
  }
  if (patch.skipTagInUrl !== undefined &&
      patch.skipTagInUrl !== (target.skipTagInUrl ?? false)) {
    columns.skipTagInUrl = patch.skipTagInUrl;
    permissionsChanged = true;
  }
  if (permissionsChanged) changed.push("permissions");

  if (issues.length > 0) return { ok: false, reason: "invalid", issues };

  // ── Apply ───────────────────────────────────────────────────────────────

  // Tag first. It is the one field whose validity depends on a race (two admins,
  // one free tag), and `setUserTag` settles that inside a transaction. Doing it
  // before any other write means a lost race leaves the account untouched.
  const nextTag = patch.tag?.trim();
  if (nextTag !== undefined && nextTag !== (target.tag ?? "")) {
    const res = await setUserTag(userId, nextTag);
    if (!res.ok) return { ok: false, reason: "invalid", issues: [{ field: "tag", reason: res.reason }] };
    changed.push("tag");
  }

  if (Object.keys(columns).length > 0) {
    await db.update(users).set(columns).where(eq(users.id, userId));
  }

  const hdrs = await headers();

  if (roleChanged && nextRole) {
    await auth.api.setRole({ body: { userId, role: nextRole }, headers: hdrs });
    changed.push("role");
  }

  if (banChanged) {
    if (nextBanned) await auth.api.banUser({ body: { userId }, headers: hdrs });
    else await auth.api.unbanUser({ body: { userId }, headers: hdrs });
    changed.push("banned");
  }

  let sessionsRevoked = false;
  if (newPassword) {
    await writeCredentialPassword(userId, newPassword);
    // A password nobody knows any more is not a lock if the old sessions stay
    // open. Whoever the admin is locking out has a cookie, not a password.
    await auth.api.revokeUserSessions({ body: { userId }, headers: hdrs });
    sessionsRevoked = true;
    changed.push("password");
  }

  // An invitation is a bearer token that sets this account's password and marks
  // it confirmed. It was mailed to the OLD address, so once the address changes
  // that mailbox must stop being a way in — otherwise "move this account to a
  // new email" leaves the previous holder able to reclaim it at any point in
  // the next seven days. The administrator can always issue a fresh one.
  if (previousEmail) await revokeInvites(userId);

  // ── Audit the two that hand over control of the account ─────────────────
  const actor = { by: session.user.id, byEmail: session.user.email };
  if (previousEmail) {
    await recordAudit(session.user.id, "admin.user.email_changed", {
      ...actor,
      targetUserId: userId,
      targetName: columns.name ?? target.name,
      from: previousEmail,
      to: columns.email,
    });
  }
  if (newPassword) {
    await recordAudit(session.user.id, "admin.user.password_reset", {
      ...actor,
      targetUserId: userId,
      targetName: columns.name ?? target.name,
      targetEmail: columns.email ?? target.email,
      sessionsRevoked: true,
    });
  }

  // ── Tell the account holder, on the two changes that take it away ───────
  const locale = await mailLocaleFor(target.locale);
  if (previousEmail && columns.email) {
    // Sent to the OLD address: the new one is by definition already in the
    // hands of whoever asked for the change, and the person who needs to know
    // is the one who just lost the account.
    const mail = renderEmailChanged({ locale, oldEmail: previousEmail, newEmail: columns.email });
    await notify(previousEmail, mail);
  }
  if (newPassword) {
    const mail = renderPasswordChanged({ locale, email: columns.email ?? target.email });
    await notify(columns.email ?? target.email, mail);
  }

  revalidatePath("/dashboard/admin");
  // Tags, permissions and the display name all show up outside the admin page.
  revalidatePath("/", "layout");

  return {
    ok: true,
    changed,
    sessionsRevoked,
    name: columns.name ?? target.name,
    email: columns.email ?? target.email,
  };
}

/**
 * Promote or demote, from the row menu.
 *
 * A thin wrapper on purpose: the self-demotion guard lives in one place, and the
 * quick action in the table must not be a way around it. Better Auth's own
 * `setRole` has no such check — an admin can absolutely strip their own role
 * through it and lock the install out of its own administration.
 */
export async function setUserRole(
  userId: string,
  role: "admin" | "user",
): Promise<UpdateUserResult> {
  return updateUserAccount(userId, { role });
}

/**
 * Suspend or reinstate an account, from the row menu. Banning ends the
 * account's sessions (Better Auth does that as part of the ban).
 */
export async function setUserBanned(userId: string, banned: boolean): Promise<UpdateUserResult> {
  return updateUserAccount(userId, { banned });
}

/** Is `value` already used by a different account, ignoring case? */
async function nameTaken(
  column: typeof users.email | typeof users.username,
  value: string,
  exceptUserId: string,
): Promise<boolean> {
  const [hit] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(sql`lower(${column})`, value.toLowerCase()))
    .limit(1);
  return !!hit && hit.id !== exceptUserId;
}

// ---------------------------------------------------------------------------
// Creating accounts
//
// An administrator may create an account whatever `register_enabled` says. The
// two are unrelated: that flag governs strangers signing THEMSELVES up, and an
// administrator is not a stranger. The gate that used to conflate them lived in
// a database hook every creation path ran through (see lib/auth.ts).
// ---------------------------------------------------------------------------

export interface CreateAccountInput {
  email: string;
  name?: string;
  role?: "admin" | "user";
  /**
   * "password" — the administrator sets one now and passes it on out of band.
   * "invite"   — the account starts with NO password and the new user sets
   *              their own through a mailed link. Preferred where mail works:
   *              nothing guessable exists during the window between creating
   *              the account and the person using it, and the administrator
   *              never learns a password that is not theirs.
   */
  mode: "password" | "invite";
  password?: string;
}

export type CreateAccountResult =
  | { ok: true; userId: string; email: string; invited: boolean; mailSent: boolean }
  | {
      ok: false;
      reason: "invalid-email" | "weak-password" | "taken" | "mail-unavailable" | "failed";
      detail?: string;
    };

export async function createAccount(input: CreateAccountInput): Promise<CreateAccountResult> {
  const session = await requireAdmin();

  const email = input.email.trim().toLowerCase();
  if (!EMAIL_PATTERN.test(email) || email.length > 254) return { ok: false, reason: "invalid-email" };

  const invite = input.mode === "invite";
  if (!invite && (!input.password || input.password.length < PASSWORD_MIN)) {
    return { ok: false, reason: "weak-password" };
  }
  if (invite && !(await mailReady())) return { ok: false, reason: "mail-unavailable" };

  const [existing] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(sql`lower(${users.email})`, email))
    .limit(1);
  if (existing) return { ok: false, reason: "taken" };

  // Better Auth owns account creation (id generation, the credential row, the
  // database hooks that assign a tag and a quota), so an invitation is created
  // WITH a throwaway password and then stripped of it. Writing the row by hand
  // would mean re-implementing all of that and drifting from it later.
  const throwaway = invite ? randomPassword() : input.password!;

  let userId: string;
  try {
    const created = await auth.api.createUser({
      body: {
        email,
        name: input.name?.trim() || email,
        password: throwaway,
        role: input.role ?? "user",
      },
      headers: await headers(),
    });
    userId = created.user.id;
  } catch (err) {
    return { ok: false, reason: "failed", detail: err instanceof Error ? err.message : undefined };
  }

  let mailSent = false;

  if (invite) {
    // Remove the throwaway credential: until the invitation is accepted the
    // account must have no password at all, not one nobody has been told.
    await db
      .update(account)
      .set({ password: null })
      .where(and(eq(account.userId, userId), eq(account.providerId, "credential")));

    const token = await createInvite(userId);
    const mail = renderAccountInvited({
      locale: await mailLocaleFor(null),
      email,
      url: `${config.appUrl}/invite/${token}`,
    });
    try {
      await sendMail({ to: email, subject: mail.subject, html: mail.html, text: mail.text });
      mailSent = true;
    } catch (err) {
      console.error("[mail] invitation not delivered:", err);
    }
  } else {
    // The administrator is asserting this address. Leaving it unconfirmed would
    // lock the account out the moment confirmation is switched on, turning
    // "create an account" into "create an account nobody can use".
    await db.update(users).set({ emailVerified: true }).where(eq(users.id, userId));
  }

  await recordAudit(session.user.id, "admin.user.created", {
    by: session.user.id,
    byEmail: session.user.email,
    targetUserId: userId,
    targetEmail: email,
    mode: input.mode,
    role: input.role ?? "user",
    mailSent,
  });

  revalidatePath("/dashboard/admin");
  return { ok: true, userId, email, invited: invite, mailSent };
}

/** A password nobody will ever use, long enough that guessing is pointless. */
function randomPassword(): string {
  return randomBytes(24).toString("base64url");
}

export type InviteActionResult =
  | { ok: true }
  | { ok: false; reason: "not-found" | "mail-unavailable" | "send-failed" };

/** Issue a fresh invitation, invalidating any earlier one. */
export async function resendInvite(userId: string): Promise<InviteActionResult> {
  const session = await requireAdmin();
  if (!userId) return { ok: false, reason: "not-found" };
  if (!(await mailReady())) return { ok: false, reason: "mail-unavailable" };

  const [target] = await db
    .select({ id: users.id, email: users.email, locale: users.locale })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!target) return { ok: false, reason: "not-found" };

  const token = await createInvite(userId);
  const mail = renderAccountInvited({
    locale: await mailLocaleFor(target.locale),
    email: target.email,
    url: `${config.appUrl}/invite/${token}`,
  });

  try {
    await sendMail({ to: target.email, subject: mail.subject, html: mail.html, text: mail.text });
  } catch (err) {
    console.error("[mail] invitation not delivered:", err);
    return { ok: false, reason: "send-failed" };
  }

  await recordAudit(session.user.id, "admin.user.invited", {
    by: session.user.id,
    byEmail: session.user.email,
    targetUserId: userId,
    targetEmail: target.email,
  });
  revalidatePath("/dashboard/admin");
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Email confirmation
// ---------------------------------------------------------------------------

/**
 * Confirm an address by hand.
 *
 * This is an administrator overriding a security gate, so it is audited. It
 * exists because the alternative, on an install whose mail is broken or whose
 * user's mailbox is gone, is an account that can never sign in again.
 */
export async function setUserEmailVerified(
  userId: string,
  verified: boolean,
): Promise<{ ok: boolean }> {
  const session = await requireAdmin();
  if (!userId) return { ok: false };

  const [target] = await db
    .select({ id: users.id, email: users.email })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!target) return { ok: false };

  await db.update(users).set({ emailVerified: verified }).where(eq(users.id, userId));
  await recordAudit(session.user.id, "admin.user.email_verified", {
    by: session.user.id,
    byEmail: session.user.email,
    targetUserId: userId,
    targetEmail: target.email,
    verified,
  });

  revalidatePath("/dashboard/admin");
  return { ok: true };
}

/** Send the confirmation link again, on the user's behalf. */
export async function sendVerificationLink(userId: string): Promise<InviteActionResult> {
  await requireAdmin();
  if (!userId) return { ok: false, reason: "not-found" };
  if (!(await mailReady())) return { ok: false, reason: "mail-unavailable" };

  const [target] = await db
    .select({ id: users.id, email: users.email })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!target) return { ok: false, reason: "not-found" };

  try {
    await auth.api.sendVerificationEmail({
      body: { email: target.email, callbackURL: "/dashboard" },
      // WITHOUT the administrator's session. Better Auth's
      // /send-verification-email is two endpoints in one: with a session it
      // means "resend MY link" and rejects any other address outright
      // (EMAIL_MISMATCH), so forwarding the caller's cookie made this button
      // fail 100% of the time, for every user, with nothing but a console line.
      // Session-less it looks the account up by address, which is what an
      // administrator sending somebody else's link needs.
      headers: await headersWithoutSession(),
    });
  } catch (err) {
    console.error("[mail] verification link not delivered:", err);
    return { ok: false, reason: "send-failed" };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Account deletion
// ---------------------------------------------------------------------------

export async function loadDeletionImpact(userId: string): Promise<UserDeletionImpact | null> {
  await requireAdmin();
  if (!userId) return null;
  return userDeletionImpact(userId);
}

/** What happens to the account's uploads. */
export type FileDisposition = "delete" | "keep";

export type DeleteAccountResult =
  | {
      ok: true;
      /** Files destroyed (disposition "delete"). */
      deleted: number;
      bytes: number;
      /** Files left behind without an owner (disposition "keep"). */
      orphaned: number;
      /** Rows storage refused to release — they are now orphans. */
      failed: number;
    }
  | { ok: false; reason: "self" | "not-found" | "forbidden" | "files-removed" };

/**
 * Delete an account, with the files going either way.
 *
 * Order: files first, account second. If the account removal fails afterwards,
 * the operator sees `files-removed` and can retry — the alternative order would
 * leave rows quietly ownerless with no error to act on.
 *
 * "keep" needs no work at all: `uploads.owner_id` is ON DELETE SET NULL, so
 * dropping the account is exactly what orphans the rows. They then show up in
 * Admin → Orphaned files, which is the whole point of the choice.
 *
 * Self-deletion is refused here as well as by Better Auth: an admin removing
 * their own account mid-session is how an install ends up with no administrator
 * at all.
 */
export async function deleteUserAccount(
  userId: string,
  disposition: FileDisposition,
): Promise<DeleteAccountResult> {
  const session = await requireAdmin();
  if (!userId) return { ok: false, reason: "not-found" };
  if (userId === session.user.id) return { ok: false, reason: "self" };

  const impact = await userDeletionImpact(userId);
  if (!impact) return { ok: false, reason: "not-found" };

  let deleted = 0;
  let bytes = 0;
  let failed = 0;

  if (disposition === "delete") {
    // Batched: an account can hold thousands of rows, and pulling every column
    // of all of them into a 2 GiB container to throw them away is how this kind
    // of maintenance job takes the app down with it.
    //
    // Rows storage refused are parked in `stuck` and excluded from the next
    // query. Without that they would come back in every batch — counted again
    // each time, and eventually spinning forever once only they are left.
    const stuck: string[] = [];
    for (;;) {
      const where = [eq(uploads.ownerId, userId)];
      if (stuck.length > 0) where.push(notInArray(uploads.id, stuck));

      const batch = await db
        .select({
          id: uploads.id,
          ownerId: uploads.ownerId,
          size: uploads.size,
          storageKey: uploads.storageKey,
          thumbKey: uploads.thumbKey,
        })
        .from(uploads)
        .where(and(...where))
        .limit(500);
      if (batch.length === 0) break;

      const result = await deleteMediaBulk(batch);
      deleted += result.deleted;
      bytes += result.bytes;

      if (result.failed > 0) {
        // deleteMediaBulk removes exactly the rows it managed to clear, so
        // whatever is still there is what it could not touch.
        const survivors = await db
          .select({ id: uploads.id })
          .from(uploads)
          .where(inArray(uploads.id, batch.map((r) => r.id)));
        for (const s of survivors) stuck.push(s.id);
        failed = stuck.length;
      }
    }
  }

  // `verification` has no foreign key to the account, so a pending invitation
  // would outlive it and keep pointing at an id that no longer resolves.
  await revokeInvites(userId);

  try {
    await auth.api.removeUser({ body: { userId }, headers: await headers() });
  } catch {
    return { ok: false, reason: deleted > 0 ? "files-removed" : "forbidden" };
  }

  revalidatePath("/dashboard/admin");
  revalidatePath("/dashboard");

  return {
    ok: true,
    deleted,
    bytes,
    failed,
    orphaned: disposition === "keep" ? impact.files : failed,
  };
}

// ---------------------------------------------------------------------------
// Maintenance
// ---------------------------------------------------------------------------

/** Recompute every account's `used_quota` from the rows that exist. */
export async function recalculateEveryQuota(): Promise<QuotaRecalcResult> {
  await requireAdmin();
  const result = await recalculateAllQuotas();
  revalidatePath("/dashboard/admin");
  return result;
}

/** Report storage objects that no database row points at. Read-only. */
export async function runStorageScan(): Promise<StorageScanResult> {
  await requireAdmin();
  return scanStorageOrphans();
}
