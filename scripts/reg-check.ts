import { chromium } from "@playwright/test";

const base = process.env.E2E_BASE_URL || "http://localhost:8420";
const b = await chromium.launch();
const N = 5;
let ok = 0;
for (let i = 0; i < N; i++) {
  const ctx = await b.newContext();
  const p = await ctx.newPage();
  const email = `reg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}@local.test`;
  await p.goto(base + "/register", { waitUntil: "domcontentloaded" });
  await p.locator("#name").fill("Reg Check");
  await p.locator("#email").fill(email);
  await p.locator("#password").fill("Password123!");
  await p.getByRole("button", { name: /create account/i }).click();
  let landed = false;
  try {
    await p.waitForURL(/\/dashboard(\?|$|\/)/, { timeout: 30000 });
    landed = true;
    ok++;
  } catch {
    landed = false;
  }
  console.log(`#${i + 1} ${email} -> ${landed ? "dashboard ✓" : "STUCK at " + p.url()}`);
  if (!landed) {
    const body = (await p.locator("body").innerText()).replace(/\s+/g, " ").slice(0, 160);
    console.log("   body:", body);
  }
  await ctx.close();
}
console.log(`\n${ok}/${N} reached dashboard`);
await b.close();
process.exit(0);
