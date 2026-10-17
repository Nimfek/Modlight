"use server";

import { headers as nextHeaders } from "next/headers";
import { eq, sql } from "drizzle-orm";
import { APIError } from "better-auth/api";
import { db } from "@/lib/db";
import { user as users } from "@/lib/db/schema";
import { auth } from "@/lib/auth";
import { checkRateLimit, clientIp } from "@/lib/password";

/**
 * Sign in with a username OR an email.
 *
 * People know their account as `alicja`, `bobby` or `admin` far more often
 * than as the address they registered with years ago. Better Auth signs in by email only, so the username has to be resolved
 * first.
 *
 * That resolution happens HERE, on the server, and the email never travels back
 * to the browser. An earlier version returned it to the client so the client
 * could call sign-in itself; that turned an unauthenticated Server Action into
 * two gifts at once — a directory of every account's email address, and a
 * reliable "does this username exist?" oracle (an answer containing `@` meant
 * yes). Server Actions are callable directly with a `Next-Action` header, so a
 * form was never needed to farm it.
 *
 * Now the caller learns exactly one thing: whether these credentials work.
 */

export type SignInResult =
  | { status: "ok" }
  | { status: "two-factor" }
  | { status: "invalid" }
  /**
   * The password was RIGHT; the address has not been confirmed.
   *
   * Reported separately because folding it into "invalid" tells the one person
   * who typed their password correctly that they got it wrong — an error they
   * can never fix by trying harder, about a problem that has nothing to do with
   * the password. Better Auth has just sent them a fresh confirmation link
   * (`emailVerification.sendOnSignIn`), so the honest message is also the
   * actionable one.
   *
   * It does not leak: reaching this branch requires already knowing the correct
   * password, so the caller learns nothing they did not supply.
   */
  | { status: "unverified" }
  | { status: "rate-limited" }
  | { status: "error" };

/** Better Auth serialises an APIError as `{ message, code }`. */
const EMAIL_NOT_VERIFIED = "EMAIL_NOT_VERIFIED";

async function isUnverified(res: Response): Promise<boolean> {
  const body = (await res
    .clone()
    .json()
    .catch(() => null)) as { code?: unknown } | null;
  return body?.code === EMAIL_NOT_VERIFIED;
}

/**
 * Look up the email behind a username. Never leaves the server.
 *
 * The two columns are NOT equal in standing, and treating them as one `OR` with
 * `LIMIT 1` was a real hazard: `username` is unique and case-folded on write
 * (app/actions/admin.ts), while `name` is a free-text display name that anybody
 * can set to anything, including somebody else's username. A single OR let the
 * database pick either row arbitrarily, so setting your display name to `bobby`
 * gave you a coin-flip's chance of standing between bobby and their account —
 * and a certainty of it if the planner happened to prefer your row.
 *
 * So: the unique column decides whenever it can, and the legacy one is consulted
 * only when it answers unambiguously.
 */
async function resolveEmail(identifier: string): Promise<string> {
  if (identifier.includes("@")) return identifier;
  const needle = identifier.toLowerCase();

  const byUsername = await db
    .select({ email: users.email })
    .from(users)
    .where(eq(sql`lower(${users.username})`, needle))
    .limit(1);
  if (byUsername[0]) return byUsername[0].email;

  // Accounts created before the username column existed carry their login
  // in `name`. Two rows means the name identifies nobody, and guessing
  // between them would hand one account's login attempts to another.
  const byName = await db
    .select({ email: users.email })
    .from(users)
    .where(eq(sql`lower(${users.name})`, needle))
    .limit(2);
  if (byName.length === 1) return byName[0].email;

  // Unknown or ambiguous falls through unchanged: sign-in then fails with the
  // same generic result as a wrong password, so there is nothing to distinguish.
  return identifier;
}

export async function signInWithIdentifier(
  identifier: string,
  password: string,
): Promise<SignInResult> {
  const raw = identifier.trim();
  if (!raw || !password) return { status: "invalid" };

  const hdrs = await nextHeaders();

  // Better Auth's own limiter only covers /api/auth/*; a Server Action is a
  // different door into the same lock, so it needs its own bolt.
  const ip = clientIp(hdrs);
  if (!checkRateLimit(`${ip}|signin`, 10, 15 * 60 * 1000).allowed) {
    return { status: "rate-limited" };
  }

  try {
    const email = await resolveEmail(raw);

    // asResponse so Better Auth's Set-Cookie headers are produced and applied
    // by the framework exactly as they are on the HTTP route.
    const res = await auth.api.signInEmail({
      body: { email, password },
      headers: hdrs,
      asResponse: true,
    });

    if (!res.ok) {
      return (await isUnverified(res)) ? { status: "unverified" } : { status: "invalid" };
    }

    const data = (await res.clone().json().catch(() => null)) as
      | { twoFactorRedirect?: boolean }
      | null;

    return data?.twoFactorRedirect ? { status: "two-factor" } : { status: "ok" };
  } catch (err) {
    // Bad credentials arrive as an APIError; anything else is a real fault and
    // must not be reported as "wrong password".
    //
    // `asResponse: true` normally turns an APIError into a Response rather than
    // a throw, so this branch is a fallback — but it still has to tell the two
    // cases apart, or a configuration change upstream would silently restore
    // the "wrong password" lie for unconfirmed accounts.
    if (err instanceof APIError) {
      const code = (err.body as { code?: unknown } | undefined)?.code;
      return code === EMAIL_NOT_VERIFIED ? { status: "unverified" } : { status: "invalid" };
    }
    console.error("[auth] sign-in failed:", err);
    return { status: "error" };
  }
}
