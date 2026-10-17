import { eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { settings } from "@/lib/db/schema";
import { config } from "@/lib/config";

/**
 * Global runtime settings (admin-configurable), stored in the `settings` table.
 *
 * Deliberately tiny: a key earns its place here only once something in the app
 * actually reads it. An earlier, larger key set outlived its features —
 *
 *   - `auto_tagging`   — the tag engine is gone; file type comes from MIME and
 *                        organisation is done with folders.
 *   - `image_embeds`   — OpenGraph/oEmbed metadata is always emitted.
 *   - `quota_enabled` / `default_user_quota`
 *                      — limits are per account (`user.max_quota`, editable in
 *                        Admin → Users) with `DEFAULT_USER_QUOTA` as the seed
 *                        for new accounts.
 *   - `custom_head`    — nothing injects it into the document head.
 *
 * A switch that changes nothing is worse than a missing one, so they were
 * removed from the panel rather than left as decoration. Rows left behind in
 * the `settings` table by older versions are simply ignored.
 */
export type SettingKey =
  // ── Registration ────────────────────────────────────────────────────────
  /** "on"/"off": may STRANGERS sign themselves up at /register? Nothing else. */
  | "register_enabled"
  /** Optional shared key a self-service sign-up must also present (encrypted). */
  | "registration_key_enc"
  // ── Mail ────────────────────────────────────────────────────────────────
  | "smtp_host"
  | "smtp_port"
  /** "none" | "starttls" | "tls" */
  | "smtp_security"
  | "smtp_user"
  | "smtp_password_enc"
  | "mail_from"
  | "mail_from_name"
  /** "on"/"off": must a new account confirm its address before signing in? */
  | "email_verification_required"
  // ── Desktop app releases ────────────────────────────────────────────────
  /**
   * The published build of Modlight App, as JSON (see lib/releases.ts).
   *
   * A settings row rather than a table because there is exactly one current
   * release per channel and it points at an ordinary upload — the binary is a
   * normal file in somebody's library, so storage, Range requests, ETags and
   * quota all already work on it and nothing new has to be invented.
   */
  | "release_app";

/**
 * Keys that may be handed to a client component.
 *
 * An ALLOWLIST rather than a deny-list, and that distinction is the whole point:
 * the admin page passes its settings object straight into a `"use client"`
 * component, so every row it contains is serialised into the RSC payload the
 * browser receives. A deny-list is a promise that whoever adds the next secret
 * key will remember to update it; an allowlist means they have to opt in.
 */
export const PANEL_SETTINGS = [
  "register_enabled",
  "smtp_host",
  "smtp_port",
  "smtp_security",
  "smtp_user",
  "mail_from",
  "mail_from_name",
  "email_verification_required",
] as const satisfies readonly SettingKey[];

/** Keys whose VALUE must never leave the server. Asserted against the list above. */
export const SECRET_SETTINGS = ["registration_key_enc", "smtp_password_enc"] as const;

export async function getSetting(key: SettingKey): Promise<string | null> {
  const rows = await db.select().from(settings).where(eq(settings.key, key)).limit(1);
  return rows[0]?.value ?? null;
}

export async function setSetting(key: SettingKey, value: string | null): Promise<void> {
  await db
    .insert(settings)
    .values({ key, value })
    .onConflictDoUpdate({ target: settings.key, set: { value } });
}

/** Read several keys in one round trip. Secrets included: server-side only. */
export async function getSettings(
  keys: readonly SettingKey[],
): Promise<Partial<Record<SettingKey, string>>> {
  if (keys.length === 0) return {};
  const rows = await db
    .select()
    .from(settings)
    .where(inArray(settings.key, keys as unknown as string[]));
  const out: Partial<Record<SettingKey, string>> = {};
  for (const r of rows) if (r.value != null) out[r.key as SettingKey] = r.value;
  return out;
}

/**
 * The settings the admin panel renders. Restricted to `PANEL_SETTINGS`, so a
 * secret added to the table later cannot reach the browser by accident.
 */
export async function getPanelSettings(): Promise<Partial<Record<SettingKey, string>>> {
  return getSettings(PANEL_SETTINGS);
}

/**
 * Seed a key only if it has never been written.
 *
 * This is how an environment variable becomes a STARTING VALUE rather than a
 * competing source of truth: the first boot copies it into the table, and from
 * then on the panel owns it. Changing the variable afterwards does nothing,
 * which is exactly the promise the panel makes when it shows a toggle.
 */
export async function seedSetting(key: SettingKey, value: string): Promise<void> {
  await db.insert(settings).values({ key, value }).onConflictDoNothing({ target: settings.key });
}

/**
 * May a stranger sign themselves up at /register?
 *
 * The database row is the answer. `REGISTRATION_ENABLED` survives only as a
 * fallback for installs that predate the seeding step — once a row exists the
 * environment is not consulted again, because a panel toggle that a variable
 * can silently overrule is a lie told by the interface.
 *
 * This flag says nothing about accounts an ADMIN creates, and nothing about the
 * very first account on a fresh install. Both are separate decisions with their
 * own guards (see lib/registration.ts).
 */
export async function isRegistrationEnabled(): Promise<boolean> {
  const v = await getSetting("register_enabled");
  if (v == null) return config.auth.registrationEnabled;
  return isOn(v);
}

export function isOn(value: string | null | undefined): boolean {
  return value === "on" || value === "true" || value === "1";
}
