import { chromium } from "@playwright/test";

const base = process.env.E2E_BASE_URL || "http://localhost:8420";
const b = await chromium.launch();
const ctx = await b.newContext();
const p = await ctx.newPage();
const errs: string[] = [];
p.on("console", (m) => {
  if (m.type() === "error") errs.push(m.text());
});
p.on("pageerror", (e) => errs.push("pageerror: " + e.message));

await p.goto(base + "/login", { waitUntil: "networkidle" });
await p.fill("input[name=email]", "admin@local.test");
await p.fill("input[name=password]", "Password123!");
await p.click("button[type=submit]");
await p.waitForURL(/\/dashboard/, { timeout: 30000 }).catch(() => {});
await p.waitForLoadState("networkidle").catch(() => {});
await p.waitForTimeout(1500);
console.log("URL:", p.url());
console.log("console errors:", errs.length);
for (const e of errs.slice(0, 12)) console.log(" -", e.slice(0, 160));
await b.close();
