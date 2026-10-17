import { describe, it, expect } from "vitest";
import bcrypt from "bcryptjs";
import { hashPassword } from "better-auth/crypto";
import { verifyUserPassword } from "@/lib/auth";

/**
 * Sign-in must keep working for accounts imported from a PHP install, whose
 * passwords are PHP `password_hash()` bcrypt hashes ($2y$) — without asking any
 * of them to reset. New passwords use Better Auth's default (scrypt).
 */
describe("verifyUserPassword — legacy bcrypt", () => {
  const password = "correct horse battery staple";

  it("accepts a PHP-style $2y$ hash with the right password", async () => {
    // bcryptjs mints $2b$; PHP writes the identical hash under the $2y$ tag.
    const hash = bcrypt.hashSync(password, 10).replace(/^\$2b\$/, "$2y$");
    expect(hash.startsWith("$2y$")).toBe(true);
    expect(hash).toHaveLength(60);
    await expect(verifyUserPassword({ hash, password })).resolves.toBe(true);
  });

  it("accepts $2a$ and $2b$ hashes too", async () => {
    const base = bcrypt.hashSync(password, 10);
    for (const prefix of ["$2a$", "$2b$"]) {
      const hash = base.replace(/^\$2b\$/, prefix);
      await expect(verifyUserPassword({ hash, password })).resolves.toBe(true);
    }
  });

  it("rejects a wrong password against a bcrypt hash", async () => {
    const hash = bcrypt.hashSync(password, 10).replace(/^\$2b\$/, "$2y$");
    await expect(verifyUserPassword({ hash, password: "wrong password" })).resolves.toBe(false);
    await expect(verifyUserPassword({ hash, password: "" })).resolves.toBe(false);
    await expect(verifyUserPassword({ hash, password: password.toUpperCase() })).resolves.toBe(false);
  });

  it("rejects a bcrypt hash of a different password", async () => {
    const hash = bcrypt.hashSync("some other secret", 10).replace(/^\$2b\$/, "$2y$");
    await expect(verifyUserPassword({ hash, password })).resolves.toBe(false);
  });
});

describe("verifyUserPassword — current scheme", () => {
  it("round-trips a hash produced by the default hasher", async () => {
    const hash = await hashPassword("a fresh modlight password");
    expect(hash.startsWith("$2")).toBe(false); // not bcrypt — must take the default path
    await expect(verifyUserPassword({ hash, password: "a fresh modlight password" })).resolves.toBe(true);
    await expect(verifyUserPassword({ hash, password: "a fresh modlight passwore" })).resolves.toBe(false);
  });
});
