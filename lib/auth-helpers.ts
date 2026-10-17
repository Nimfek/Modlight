import "server-only";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";

/** Resolve the current session (or null) on the server. */
export async function getSession() {
  return auth.api.getSession({ headers: await headers() });
}

/** Require a signed-in user; redirect to /login otherwise. */
export async function requireUser() {
  const session = await getSession();
  if (!session) redirect("/login");
  return session;
}

/** Require an admin; redirect away otherwise. */
export async function requireAdmin() {
  const session = await requireUser();
  if (session.user.role !== "admin") redirect("/dashboard");
  return session;
}

/**
 * The request's headers with every credential removed.
 *
 * For calling a Better Auth endpoint ON SOMEBODY ELSE'S BEHALF. Several of them
 * behave differently once they can see a session, and `/send-verification-email`
 * is the one that bites: given a session it insists the address in the body
 * matches the session's own (`EMAIL_MISMATCH`), which is right for "resend my
 * link" and makes "send THIS user their link" fail every single time an
 * administrator clicks it. With no session it looks the account up by address
 * and sends, which is the behaviour wanted here.
 *
 * Origin, host and user-agent are kept: those feed CSRF and origin checks that
 * should still see a genuine request. Only the things that ASSERT AN IDENTITY
 * are dropped.
 */
export async function headersWithoutSession(): Promise<Headers> {
  const copy = new Headers(await headers());
  copy.delete("cookie");
  copy.delete("authorization");
  return copy;
}
