import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth-helpers";

/**
 * Modlight is a closed tool: accounts are created by an administrator, not by
 * signing up. So the root URL is not a marketing page — it goes straight to
 * where a visitor actually needs to be.
 *
 * The marketing page still exists at /welcome for anyone who wants to link to it.
 */
export default async function Root() {
  const session = await getSession();
  redirect(session ? "/dashboard" : "/login");
}
