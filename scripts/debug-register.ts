import { chromium } from "@playwright/test";

const base = "http://localhost:8420";
const b = await chromium.launch();
const ctx = await b.newContext();
const p = await ctx.newPage();
const errs: string[] = [];
p.on("console", (m) => {
  if (m.type() === "error") errs.push(m.text());
});
p.on("pageerror", (e) => errs.push("pageerror: " + e.message));

const email = "dbg_" + Date.now() + "@local.test";
await p.goto(base + "/register", { waitUntil: "networkidle" });
console.log("inputs:", await p.locator("input").count());
await p.fill("input[name=name]", "Dbg").catch((e) => console.log("name fill err", String(e)));
await p.fill("input[name=email]", email).catch((e) => console.log("email fill err", String(e)));
await p.fill("input[name=password]", "Password123!").catch((e) => console.log("pw fill err", String(e)));
await p.click("button[type=submit]");
await p.waitForTimeout(22000);
console.log("URL after submit:", p.url());
console.log("inbox visible:", await p.getByText(/check your inbox/i).isVisible().catch(() => false));
console.log("body[0..240]:", (await p.locator("body").innerText()).replace(/\s+/g, " ").slice(0, 240));
console.log("console errors:", errs.slice(0, 12));
await b.close();
