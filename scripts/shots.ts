import { chromium } from "@playwright/test";

const base = process.env.E2E_BASE_URL || "http://localhost:8420";
const out = "data/shots";

const browser = await chromium.launch();
const ctx = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  colorScheme: "dark",
  deviceScaleFactor: 1,
});
const page = await ctx.newPage();

async function shot(name: string) {
  await page.waitForTimeout(700);
  await page.screenshot({ path: `${out}/${name}.png` });
  console.log("shot:", name, "->", page.url());
}

await page.goto(`${base}/`, { waitUntil: "networkidle" });
await shot("01-landing");

await page.goto(`${base}/login`, { waitUntil: "networkidle" });
await shot("02-login");

await page.fill("input[name=email]", "admin@local.test");
await page.fill("input[name=password]", "Password123!");
await page.click("button[type=submit]");
await page.waitForURL(/\/dashboard/, { timeout: 20000 }).catch(() => {});
await page.waitForLoadState("networkidle").catch(() => {});
await shot("03-dashboard");

for (const [path, name] of [
  ["/dashboard/upload", "04-upload"],
  ["/dashboard/tokens", "05-tokens"],
  ["/dashboard/profile", "06-profile"],
  ["/dashboard/admin", "07-admin"],
  ["/dashboard/paste", "08-paste"],
  ["/dashboard/links", "09-links"],
  ["/dashboard/albums", "10-albums"],
] as const) {
  await page.goto(`${base}${path}`, { waitUntil: "networkidle" }).catch(() => {});
  await shot(name);
}

await browser.close();
console.log("done");
