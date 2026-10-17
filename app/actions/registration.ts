"use server";

/**
 * Administration of who may sign themselves up.
 *
 * The two settings here answer different questions and are deliberately kept
 * apart:
 *
 *   register_enabled     — may a stranger create an account at all?
 *   registration key     — WHICH stranger, once the answer above is yes?
 *
 * The key never opens a closed registration (see lib/registration.ts). That is
 * what keeps the toggle usable as an emergency stop: one switch, one meaning.
 */

import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/auth-helpers";
import { recordAudit } from "@/lib/audit";
import { isRegistrationEnabled, setSetting } from "@/lib/settings";
import {
  REGISTRATION_KEY_MAX,
  readRegistrationKey,
  registrationKeyState,
  setRegistrationKey,
  type RegistrationKeyState,
} from "@/lib/registration";

export interface RegistrationSettings {
  enabled: boolean;
  keyState: RegistrationKeyState;
}

export async function loadRegistrationSettings(): Promise<RegistrationSettings> {
  await requireAdmin();
  const [enabled, keyState] = await Promise.all([isRegistrationEnabled(), registrationKeyState()]);
  return { enabled, keyState };
}

export async function setRegistrationEnabled(enabled: boolean): Promise<RegistrationSettings> {
  const session = await requireAdmin();
  await setSetting("register_enabled", enabled ? "on" : "off");
  await recordAudit(session.user.id, "admin.registration_toggled", {
    by: session.user.id,
    byEmail: session.user.email,
    enabled,
  });
  revalidatePath("/dashboard/admin");
  // /register, /login and the landing page all read this flag on render.
  revalidatePath("/", "layout");
  return loadRegistrationSettings();
}

export type SaveRegistrationKeyResult =
  | { ok: true; keyState: RegistrationKeyState }
  | { ok: false; reason: "too-long" };

/** Set or clear the shared key. An empty string clears it. */
export async function saveRegistrationKey(key: string | null): Promise<SaveRegistrationKeyResult> {
  const session = await requireAdmin();
  const value = key?.trim() ?? "";
  if (value.length > REGISTRATION_KEY_MAX) return { ok: false, reason: "too-long" };

  await setRegistrationKey(value || null);
  await recordAudit(session.user.id, "admin.registration_key_changed", {
    by: session.user.id,
    byEmail: session.user.email,
    // The key itself is a secret handed out by hand; the audit records only
    // that it moved.
    cleared: value.length === 0,
  });

  revalidatePath("/dashboard/admin");
  revalidatePath("/", "layout");
  return { ok: true, keyState: await registrationKeyState() };
}

/**
 * Show the administrator the key, on request.
 *
 * Deliberately different from the SMTP password, which never comes back. This
 * key exists to be given to people, so an administrator has to be able to read
 * it in order to use it at all. What that buys is a reveal that leaves a trace:
 * every disclosure is an audit entry naming who asked.
 */
export async function revealRegistrationKey(): Promise<{ key: string | null }> {
  const session = await requireAdmin();
  const key = await readRegistrationKey();
  await recordAudit(session.user.id, "admin.registration_key_revealed", {
    by: session.user.id,
    byEmail: session.user.email,
  });
  return { key };
}
