import { betterAuth } from "better-auth";
import { admin, twoFactor } from "better-auth/plugins";
import { nextCookies } from "better-auth/next-js";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { hashPassword, verifyPassword } from "better-auth/crypto";
import bcrypt from "bcryptjs";
import { count, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { user as users } from "@/lib/db/schema";
import { config } from "@/lib/config";
import { userCode as genUserCode } from "@/lib/ids";
import { evaluateSignUp } from "@/lib/registration";
import { clientIp } from "@/lib/password";
import { mailReady, verificationRequiredSync } from "@/lib/mail-settings";
import { sendMail } from "@/lib/mail";
import {
  pickMailLocale,
  renderResetPassword,
  renderVerifyEmail,
} from "@/lib/mail-templates";

async function uniqueUserCode(): Promise<string> {
  // 6-char pronounceable code; retry on the (rare) collision.
  for (let i = 0; i < 50; i++) {
    const code = genUserCode(6);
    const hit = await db.select({ id: users.id }).from(users).where(eq(users.userCode, code)).limit(1);
    if (hit.length === 0) return code;
  }
  throw new Error("Could not allocate a unique user code");
}

/** PHP `password_hash()` output: `$2y$`, plus the `$2a$`/`$2b$` variants. */
const LEGACY_BCRYPT = /^\$2[aby]\$/;

/**
 * Password verification with a legacy path.
 *
 * Accounts imported from a PHP install carry bcrypt hashes, so those users keep
 * signing in with the password they already have instead of being forced
 * through a reset. Everything hashed by us uses Better Auth's default (scrypt).
 *
 * bcrypt only ever considered the first 72 bytes of a password — that is baked
 * into the hashes we inherited, so it is a property of the legacy data, not
 * something to work around here.
 */
export async function verifyUserPassword({
  hash,
  password,
}: {
  hash: string;
  password: string;
}): Promise<boolean> {
  if (LEGACY_BCRYPT.test(hash)) return bcrypt.compare(password, hash);
  return verifyPassword({ hash, password });
}

/**
 * Language for a message sent to `user`, honouring their preference.
 *
 * The user object Better Auth hands to a mail callback is typed as its own
 * base shape, without the additional fields we declare below, so `locale` is
 * read through a cast. It is present at runtime: `additionalFields` are part of
 * the row the adapter selects.
 */
function localeFor(user: unknown, request?: Request) {
  const locale = (user as { locale?: string | null } | null)?.locale ?? null;
  return pickMailLocale(locale, request?.headers.get("accept-language") ?? null);
}

export const auth = betterAuth({
  appName: config.appName,
  baseURL: config.appUrl,
  secret: config.auth.secret,
  database: drizzleAdapter(db, { provider: "pg", schema, usePlural: false }),

  // Rate limiting: keep abuse protection, but the default per-path auth limits
  // are strict enough to block a small team registering in quick succession.
  // Loosen sign-up/sign-in to sane bursts while still throttling mass abuse.
  rateLimit: {
    enabled: true,
    window: 60,
    max: 120,
    customRules: {
      "/sign-up/email": { window: 60, max: 30 },
      "/sign-in/email": { window: 60, max: 30 },
    },
  },

  // The rate limiter keys on the client IP, which behind a reverse proxy comes
  // from a header. X-Forwarded-For is client-appendable, so a spoofed first
  // entry would give every request a fresh bucket and defeat the limit above.
  //
  // The reverse proxy MUST therefore set x-real-ip to the real peer address
  // (Caddy's reverse_proxy does by default; nginx needs
  // `proxy_set_header X-Real-IP $remote_addr;`). Better Auth SKIPS rate
  // limiting when it can't resolve an IP, so a proxy that drops this header
  // silently disables the throttle — it logs a warning when that happens.
  advanced: {
    ipAddress: {
      ipAddressHeaders: ["x-real-ip"],
    },
  },

  emailAndPassword: {
    enabled: true,

    /**
     * A GETTER, not a constant, and that is load-bearing.
     *
     * Better Auth reads this option on every sign-in
     * (api/routes/sign-in.mjs), and it only ever copies the top level of the
     * options object, so the reference to this literal survives. Reading a
     * snapshot here is therefore what lets an administrator turn address
     * confirmation on from the panel and have it take effect immediately,
     * instead of on the next deploy.
     *
     * It has to be synchronous, hence the snapshot in lib/mail-settings.ts
     * rather than a query. And it is deliberately false whenever outgoing mail
     * is not working: requiring a confirmation that can never be sent locks
     * every account out of an install, which is the single worst outcome this
     * whole feature could produce.
     */
    get requireEmailVerification() {
      return verificationRequiredSync();
    },

    password: {
      hash: hashPassword,
      verify: verifyUserPassword,
    },
    sendResetPassword: async ({ user, url }, request) => {
      const mail = renderResetPassword({
        locale: localeFor(user, request),
        email: user.email,
        url,
      });
      // No mailReady() guard here on purpose: a reset that cannot be sent must
      // fail rather than report success, and /forgot refuses to render its form
      // at all when mail is off, so this path is not normally reachable.
      await sendMail({ to: user.email, subject: mail.subject, html: mail.html, text: mail.text });
    },
  },
  emailVerification: {
    sendOnSignUp: true,
    /**
     * Send a fresh link when a CORRECT password is refused for being
     * unconfirmed.
     *
     * Without this, the confirmation mail is deliverable exactly once, at
     * sign-up. Lose it — expired, spam-foldered, wrong address typed — and the
     * account is unreachable forever, because /login has no way to ask for
     * another one and the link in the original mail is the only one that will
     * ever exist.
     *
     * It is not a mail cannon: Better Auth only reaches this branch AFTER
     * verifying the password (sign-in.mjs checks the credential first), so a
     * stranger cannot use it to post to somebody's mailbox. The only person who
     * can trigger it is the account's owner, and only by asking to sign in.
     */
    sendOnSignIn: true,
    autoSignInAfterVerification: true,
    sendVerificationEmail: async ({ user, url }, request) => {
      // Sign-up must not fail because the install has no SMTP server. When mail
      // is off, verification is not required either (see the getter above), so
      // there is simply nothing to send.
      if (!(await mailReady())) return;
      const mail = renderVerifyEmail({
        locale: localeFor(user, request),
        email: user.email,
        url,
      });
      await sendMail({ to: user.email, subject: mail.subject, html: mail.html, text: mail.text });
    },
  },

  user: {
    additionalFields: {
      userCode: { type: "string", required: false, input: false },
      usedQuota: { type: "number", required: false, defaultValue: 0, input: false },
      maxQuota: { type: "number", required: false, defaultValue: -1, input: false },
      hideUploads: { type: "boolean", required: false, defaultValue: false, input: true },
      copyRaw: { type: "boolean", required: false, defaultValue: false, input: true },
      // Visual theme applied to the user's panel AND their public links/galleries.
      theme: { type: "string", required: false, defaultValue: "modern", input: true },
      // UI language override: 'pl' | 'en' | null (null = auto by system locale).
      locale: { type: "string", required: false, input: true },
    },
  },

  /**
   * The self-service registration gate.
   *
   * It sits HERE, on one path, and not in `databaseHooks.user.create.before`.
   * That hook runs for every way an account can come into existence, the admin
   * panel's `admin.createUser` included, so putting the gate there meant an
   * administrator had to open registration to the whole internet in order to
   * create one account by hand. Which is the bug this moves away from.
   *
   * `/sign-up/email` is the only endpoint a stranger can reach unauthenticated.
   * `/admin/create-user` has its own authorisation check in the admin plugin,
   * and needs no permission from this flag.
   */
  hooks: {
    before: createAuthMiddleware(async (ctx) => {
      if (ctx.path !== "/sign-up/email") return;

      const body = (ctx.body ?? {}) as { registrationKey?: unknown };
      const headers = ctx.headers ?? new Headers();
      const decision = await evaluateSignUp({
        clientIp: clientIp(headers),
        suppliedKey: typeof body.registrationKey === "string" ? body.registrationKey : null,
      });
      if (decision.allow) return;

      switch (decision.reason) {
        case "rate-limited":
          throw new APIError("TOO_MANY_REQUESTS", {
            message: "Too many attempts. Try again later.",
            code: "SIGNUP_RATE_LIMITED",
          });
        case "closed":
          throw new APIError("FORBIDDEN", {
            message: "Registration is currently disabled.",
            code: "REGISTRATION_DISABLED",
          });
        case "key-required":
          throw new APIError("BAD_REQUEST", {
            message: "A registration key is required.",
            code: "REGISTRATION_KEY_REQUIRED",
          });
        case "key-invalid":
          throw new APIError("BAD_REQUEST", {
            message: "That registration key is not valid.",
            code: "REGISTRATION_KEY_INVALID",
          });
      }
    }),
  },

  databaseHooks: {
    user: {
      create: {
        /**
         * Stamp the columns every account needs, whatever created it.
         *
         * Deliberately free of any permission check: this hook runs for the
         * admin panel and for a self-service sign-up alike, so a rule about WHO
         * may register has no way to tell them apart. See `hooks.before`.
         */
        before: async (newUser) => {
          const [{ n }] = await db.select({ n: count() }).from(users);
          const isFirst = Number(n ?? 0) === 0;

          // The first account administers the install. After that, an explicit
          // role is honoured: it can only have come from `/admin/create-user`,
          // which the admin plugin already guards, and overwriting it here was
          // silently downgrading every administrator created from the panel.
          const supplied = (newUser as { role?: unknown }).role;
          const role = isFirst
            ? "admin"
            : supplied === "admin" || supplied === "user"
              ? supplied
              : "user";

          return {
            data: {
              ...newUser,
              role,
              userCode: await uniqueUserCode(),
              maxQuota: config.defaultUserQuota,
            },
          };
        },
      },
    },
  },

  plugins: [
    admin(), // roles (admin|user), ban/unban (account enable/disable), sessions
    twoFactor({ issuer: config.appName }),
    // ShareX/API upload tokens use our own `api_tokens` table (direct DB lookup
    // at the raw server layer) — keeps the hot upload path decoupled & fast.
    nextCookies(), // MUST be last — sets cookies in Next server actions
  ],
});

export type Session = typeof auth.$Infer.Session;
