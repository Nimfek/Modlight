import "dotenv/config";
import { chromium } from "@playwright/test";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { user as users } from "@/lib/db/schema";

const theme = process.argv[2] || "win98";
await db.update(users).set({ theme }).where(eq(users.email, "admin@local.test"));

const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: "dark" });
const p = await ctx.newPage();
await p.goto("http://localhost:8420/login", { waitUntil: "networkidle" });
await p.fill("input[name=email]", "admin@local.test");
await p.fill("input[name=password]", "Password123!");
await p.click("button[type=submit]");
await p.waitForURL(/dashboard/, { timeout: 40000 }).catch(() => {});
await p.waitForLoadState("networkidle").catch(() => {});
await p.waitForTimeout(1800);
await p.screenshot({ path: `data/shots/theme-${theme}.png` });
console.log("themed", theme, "->", p.url());
await b.close();
process.exit(0);
