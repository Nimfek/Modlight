import "dotenv/config";
import sharp from "sharp";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { user as users, shortLinks } from "@/lib/db/schema";
import { createApiToken } from "@/lib/api-token";
import { humanCode } from "@/lib/ids";

const base = process.env.E2E_BASE_URL || "http://localhost:8420";

const admin = (await db.select().from(users).where(eq(users.email, "admin@local.test")).limit(1))[0];
if (!admin) throw new Error("no admin");

// 1) Upload a real PNG via the ShareX endpoint
// Only uploads and reads back, so it asks for the scope that covers both.
const token = await createApiToken(admin.id, "verify", "write");
const png = await sharp({ create: { width: 40, height: 30, channels: 3, background: { r: 200, g: 50, b: 120 } } })
  .png()
  .toBuffer();
const fd = new FormData();
fd.append("upload", new Blob([new Uint8Array(png)], { type: "image/png" }), "verify.png");
const up = await fetch(`${base}/upload`, { method: "POST", headers: { "x-api-key": token }, body: fd }).then((r) => r.json());
console.log("UPLOAD:", up.message, up.url);

// 2) Convert that image to PDF
const m = /\/([^/]+)\/([^/.]+)\.png$/.exec(up.url ?? "");
if (!m) throw new Error("could not parse upload url: " + up.url);
const [, userCode, code] = m;
const pdfRes = await fetch(`${base}/${userCode}/${code}/convert?to=pdf`);
const pdfBuf = Buffer.from(await pdfRes.arrayBuffer());
console.log("CONVERT->PDF:", pdfRes.status, "magic:", pdfBuf.subarray(0, 5).toString("latin1"), "bytes:", pdfBuf.length);

// 3) Short link redirect
const slCode = humanCode(7);
await db.insert(shortLinks).values({ ownerId: admin.id, code: slCode, target: "https://example.com/landed" });
const rd = await fetch(`${base}/s/${slCode}`, { redirect: "manual" });
console.log("SHORTLINK:", rd.status, "->", rd.headers.get("location"));

process.exit(0);
