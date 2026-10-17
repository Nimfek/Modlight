"use server";

/**
 * The public half of the invitation flow, plus the "send it again" button for
 * address confirmation.
 *
 * Both are unauthenticated by necessity: the person using them cannot sign in
 * yet. They are therefore throttled by caller, and neither reveals whether an
 * account exists.
 */

import { headers } from "next/headers";
import { auth } from "@/lib/auth";
import { headersWithoutSession } from "@/lib/auth-helpers";
import { acceptInvite, readInvite, INVITE_PASSWORD_MIN } from "@/lib/invites";
import { checkRateLimit, clientIp } from "@/lib/password";
import { mailReady } from "@/lib/mail-settings";

export interface InvitePreview {
  email: string;
  name: string;
}

/** What the invitation page shows before a password is chosen. */
export async function previewInvite(token: string): Promise<InvitePreview | null> {
  const subject = await readInvite(token);
  return subject ? { email: subject.email, name: subject.name } : null;
}

export type AcceptInvitationResult =
  | { ok: true }
  | { ok: false; reason: "invalid" | "weak-password" | "rate-limited" | "sign-in-failed" };

/**
 * Set the password an invitation was issued for, then sign the person in.
 *
 * Signing in here rather than redirecting to /login is what makes the flow one
 * step instead of three, and it is safe for the same reason the invitation is:
 * possession of the token proved control of the mailbox, and the password was
 * just chosen by whoever is holding the session.
 */
export async function acceptInvitation(
  token: string,
  password: string,
): Promise<AcceptInvitationResult> {
  const hdrs = await headers();
  const gate = checkRateLimit(`invite:${clientIp(hdrs)}`, 10, 15 * 60_000);
  if (!gate.allowed) return { ok: false, reason: "rate-limited" };

  if (password.length < INVITE_PASSWORD_MIN) return { ok: false, reason: "weak-password" };

  const result = await acceptInvite(token, password);
  if (!result.ok) {
    return { ok: false, reason: result.reason === "weak-password" ? "weak-password" : "invalid" };
  }

  try {
    await auth.api.signInEmail({
      body: { email: result.email, password },
      headers: hdrs,
      // nextCookies() is what turns the Set-Cookie of this call into a real
      // cookie on the action's response.
      asResponse: false,
    });
  } catch {
    // The password is set either way, so this is recoverable at /login.
    return { ok: false, reason: "sign-in-failed" };
  }

  return { ok: true };
}

export type ResendVerificationResult =
  | { ok: true }
  | { ok: false; reason: "rate-limited" | "mail-unavailable" };

/**
 * Send the confirmation link again.
 *
 * Always reports success once it has been allowed to try, whatever the address
 * turns out to be: an answer that differed for a known and an unknown address
 * would turn this into an account-enumeration endpoint.
 */
export async function resendVerification(email: string): Promise<ResendVerificationResult> {
  const hdrs = await headers();
  const address = email.trim().toLowerCase();

  // Keyed on the address as well as the caller, so one mailbox cannot be
  // flooded from a rotating set of addresses.
  const byIp = checkRateLimit(`verify-resend-ip:${clientIp(hdrs)}`, 5, 15 * 60_000);
  const byAddress = checkRateLimit(`verify-resend:${address}`, 3, 15 * 60_000);
  if (!byIp.allowed || !byAddress.allowed) return { ok: false, reason: "rate-limited" };

  if (!(await mailReady())) return { ok: false, reason: "mail-unavailable" };

  try {
    await auth.api.sendVerificationEmail({
      body: { email: address, callbackURL: "/dashboard" },
      // Session-less by design. Normally there is no session here anyway (the
      // caller cannot sign in yet), but a signed-in visitor who lands on
      // /register would otherwise hit the "resend MY link" branch and get
      // EMAIL_MISMATCH for anybody else's address, swallowed below into a
      // silent success.
      headers: await headersWithoutSession(),
    });
  } catch {
    // Swallowed on purpose: "no such account" and "sent" must look identical.
  }
  return { ok: true };
}
