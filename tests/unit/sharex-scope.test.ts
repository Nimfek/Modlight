import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import http, { type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { tokenOk, tokenScoped, tokenUnknown } from "../helpers/token-auth";

/**
 * `POST /upload` refusing a token that is real and too narrow.
 *
 * Driven over real HTTP, like tests/unit/upload-sharex.test.ts, because the
 * thing being asserted is a status code and a body on the wire - and because
 * this endpoint answers ShareX, whose error dialog shows the user whatever comes
 * back. A 401 with nothing in it is what makes somebody regenerate a config that
 * was never the problem.
 *
 * Only the token store is stubbed. `tokenRefusal` is the real one: the wording
 * IS the subject.
 */

const authenticateApiToken = vi.fn();

vi.mock("@/lib/api-token", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api-token")>("@/lib/api-token");
  return { ...actual, authenticateApiToken };
});

const BOUNDARY = "----modlightscope";
let tmpRoot: string;
let server: Server;
let port: number;

beforeAll(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), "modlight-scope-"));
  process.env.UPLOAD_TMP_PATH = tmpRoot;

  const { handleShareXUpload } = await import("@/lib/upload/sharex");
  server = http.createServer((req: IncomingMessage, res: ServerResponse) => {
    void handleShareXUpload(req, res).catch(() => {});
  });
  server.listen(0);
  await once(server, "listening");
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  server?.close();
  await rm(tmpRoot, { recursive: true, force: true });
});

beforeEach(() => authenticateApiToken.mockReset());

function multipart(parts: { field?: [string, string]; file?: string }[]): Buffer {
  const chunks: Buffer[] = [];
  for (const part of parts) {
    if (part.field) {
      chunks.push(
        Buffer.from(
          `--${BOUNDARY}\r\nContent-Disposition: form-data; name="${part.field[0]}"\r\n\r\n${part.field[1]}\r\n`,
        ),
      );
    }
    if (part.file) {
      chunks.push(
        Buffer.from(
          `--${BOUNDARY}\r\nContent-Disposition: form-data; name="upload"; filename="a.txt"\r\n` +
            `Content-Type: text/plain\r\n\r\n${part.file}\r\n`,
        ),
      );
    }
  }
  chunks.push(Buffer.from(`--${BOUNDARY}--\r\n`));
  return Buffer.concat(chunks);
}

function post(
  body: Buffer,
  headers: Record<string, string> = {},
): Promise<{ status: number; json: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        port,
        method: "POST",
        path: "/upload",
        headers: {
          "content-type": `multipart/form-data; boundary=${BOUNDARY}`,
          "content-length": body.length,
          ...headers,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString();
          resolve({ status: res.statusCode ?? 0, json: text ? JSON.parse(text) : {} });
        });
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

describe("POST /upload and token scope", () => {
  it("asks for the `upload` capability and nothing wider", async () => {
    authenticateApiToken.mockResolvedValue(tokenUnknown());
    await post(multipart([{ file: "hello" }]), { "x-api-key": "tok" });
    // A ShareX config that could also list or delete a library would make the
    // narrowest scope pointless, since this is where nearly every token on the
    // deployment is used.
    expect(authenticateApiToken).toHaveBeenCalledWith("tok", "upload");
  });

  it("refuses a read-only token with 403 and says which scope it needed", async () => {
    authenticateApiToken.mockResolvedValue(
      tokenScoped({ id: "u1", banned: false, role: "user" }, "read", "upload"),
    );
    const res = await post(multipart([{ file: "hello" }]), { "x-api-key": "tok" });

    expect(res.status).toBe(403);
    expect(res.json).toMatchObject({
      reason: "insufficient_scope",
      scope: "read",
      required_scope: "upload",
    });
    // Somebody is reading this in a ShareX error dialog, so it has to name the
    // thing to go and create.
    expect(String(res.json.message)).toContain('"upload"');
  });

  it("keeps the 404 for a token that does not exist", async () => {
    // Unchanged on purpose: ShareX users and third-party scripts have matched on
    // this status and this sentence since v1. Only the NEW refusal is a 403.
    authenticateApiToken.mockResolvedValue(tokenUnknown());
    const res = await post(multipart([{ file: "hello" }]), { "x-api-key": "nope" });
    expect(res.status).toBe(404);
    expect(res.json).toMatchObject({ message: "Token specified not found." });
  });

  it("refuses a narrow token sent the legacy way, after the file", async () => {
    // The pre-header ShareX config posts the token as a form field, and ShareX
    // may emit it AFTER the payload - so this path authenticates once the body
    // is in. It has to reach the same verdict as the header path, or the older
    // config would be the way around the scope.
    authenticateApiToken.mockResolvedValue(
      tokenScoped({ id: "u1", banned: false, role: "user" }, "read", "upload"),
    );
    const res = await post(multipart([{ file: "hello" }, { field: ["token", "tok"] }]));
    expect(res.status).toBe(403);
    expect(res.json).toMatchObject({ reason: "insufficient_scope", required_scope: "upload" });
  });

  it("refuses a narrow token sent the legacy way, before the file", async () => {
    // The other ordering, which authenticates mid-stream. A token that arrives
    // early and is refused must NOT lift the anonymous size cap on its way out.
    authenticateApiToken.mockResolvedValue(
      tokenScoped({ id: "u1", banned: false, role: "user" }, "read", "upload"),
    );
    const res = await post(multipart([{ field: ["token", "tok"] }, { file: "hello" }]));
    expect(res.status).toBe(403);
  });

  it("lets an upload-scoped token through the auth gate", async () => {
    // It fails later, on storage, which is not what this file is about - what
    // matters is that the refusal above is about the SCOPE and not about tokens
    // in general.
    authenticateApiToken.mockResolvedValue(tokenOk({ id: "u1", banned: false }, "upload"));
    const res = await post(multipart([{ file: "hello" }]), { "x-api-key": "tok" });
    expect(res.status).not.toBe(403);
    expect(res.json.reason).toBeUndefined();
  });
});
