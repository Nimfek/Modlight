import { chromium } from "@playwright/test";

const base = process.env.E2E_BASE_URL || "http://localhost:8420";
const b = await chromium.launch();
// Polish browser context -> the app should render in Polish.
const ctx = await b.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: "dark", locale: "pl-PL" });
const p = await ctx.newPage();
await p.goto(base + "/login", { waitUntil: "networkidle" });
await p.locator("#email").fill("admin@local.test");
await p.locator("#password").fill("Password123!");
await p.getByRole("button", { name: /zaloguj|sign in/i }).click();
await p.waitForURL(/\/dashboard/, { timeout: 40000 }).catch(() => {});
await p.waitForLoadState("networkidle").catch(() => {});
await p.waitForTimeout(1500);
await p.screenshot({ path: "data/shots/pl-dashboard.png" });
console.log("pl dashboard ->", p.url());
await b.close();
process.exit(0);
