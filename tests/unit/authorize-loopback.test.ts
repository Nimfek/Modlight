import { describe, it, expect } from "vitest";
import {
  CLIENT_NAME_MAX,
  MAX_PORT,
  MIN_PORT,
  TOKEN_NAME_MAX,
  authorizePath,
  loopbackCallback,
  parseAuthorizeRequest,
  parseLoopbackPort,
  parseState,
  sanitizeClientName,
  tokenNameFor,
} from "@/lib/authorize/loopback";

/**
 * The gate in front of the desktop sign-in flow.
 *
 * Everything pinned here guards the same thing: at the end of this handshake an
 * API TOKEN is posted to a URL, and that URL is built from a query parameter a
 * stranger may have written. A parser one shade too generous does not produce a
 * broken page, it produces a credential delivered to somebody else.
 */

/**
 * The invisible characters this file is about, spelled by code point.
 *
 * A test whose subject is a character you cannot see must not contain one: a
 * literal U+202E in the source would reverse the rest of the line in every
 * editor that opens it, which is the exact trick being defended against.
 */
/** RIGHT-TO-LEFT OVERRIDE. */
const RTL_OVERRIDE = String.fromCharCode(0x202e);
/** U+200B ZERO WIDTH SPACE. */
const ZERO_WIDTH = String.fromCharCode(0x200b);
/** U+00A0 NO-BREAK SPACE: whitespace, but not the kind `trim()` is asked about. */
const NBSP = String.fromCharCode(0x00a0);

describe("loopback port", () => {
  it("accepts the ephemeral ports a desktop listener actually binds", () => {
    expect(parseLoopbackPort("1024")).toBe(MIN_PORT);
    expect(parseLoopbackPort("8420")).toBe(8420);
    expect(parseLoopbackPort("65535")).toBe(MAX_PORT);
    // Whitespace around a value is a copy-paste artefact, not an attack.
    expect(parseLoopbackPort(" 49732 ")).toBe(49732);
  });

  it("refuses privileged ports", () => {
    // A desktop app's loopback listener never binds one, so a link pointing at
    // 22 or 631 was written by somebody aiming the token at a local service
    // that is not the app the user thinks they are approving.
    expect(parseLoopbackPort("22")).toBeNull();
    expect(parseLoopbackPort("631")).toBeNull();
    expect(parseLoopbackPort("1023")).toBeNull();
    expect(parseLoopbackPort("0")).toBeNull();
  });

  it("refuses every spelling of a number that is not plain digits", () => {
    // This is the case the regex exists for: `Number()` reads all of these as a
    // port, and each one is a string somebody deliberately wrote that way to
    // get past a check that only looks at the numeric value.
    expect(parseLoopbackPort("0x1f90")).toBeNull(); // 8080
    expect(parseLoopbackPort("1e4")).toBeNull(); // 10000
    expect(parseLoopbackPort("+8080")).toBeNull();
    expect(parseLoopbackPort("8080.0")).toBeNull();
    expect(parseLoopbackPort("08080")).toBeNull();
    expect(parseLoopbackPort("8_080")).toBeNull();
  });

  it("refuses anything that is not a port at all", () => {
    expect(parseLoopbackPort("")).toBeNull();
    expect(parseLoopbackPort(undefined)).toBeNull();
    expect(parseLoopbackPort("65536")).toBeNull();
    expect(parseLoopbackPort("999999")).toBeNull();
    expect(parseLoopbackPort("8080@evil.example")).toBeNull();
    expect(parseLoopbackPort("8080/../..")).toBeNull();
  });

  it("refuses a repeated parameter instead of picking one", () => {
    // `?port=8080&port=1` is not something a client sends by accident, and
    // choosing "the first" is exactly how two parties read one URL differently.
    expect(parseLoopbackPort(["8080", "1"])).toBeNull();
    expect(parseState(["abcdefgh", "ijklmnop"])).toBeNull();
  });
});

describe("state", () => {
  it("accepts an opaque URL-safe nonce", () => {
    expect(parseState("KZ9-x_2Q.tilde~ok")).toBe("KZ9-x_2Q.tilde~ok");
    expect(parseState("a".repeat(128))).toHaveLength(128);
  });

  it("refuses a value too short to tell two requests apart", () => {
    // The whole job of `state` is letting the app recognise its own request. A
    // one-character nonce is guessable, which makes it decoration.
    expect(parseState("1")).toBeNull();
    expect(parseState("abcdefg")).toBeNull();
    expect(parseState("a".repeat(129))).toBeNull();
  });

  it("refuses characters that would need escaping downstream", () => {
    // The value is echoed into a JSON body handed to a local listener and shown
    // on the page. Restricting it to the URL-unreserved set means there is
    // nothing to escape anywhere, rather than three places that must remember.
    for (const bad of [
      'abcdefgh"',
      "abcdefgh<script>",
      "abcdefgh\nabcdefgh",
      "abcdefgh}",
      "abcd efgh",
      "abcdefgh%00",
    ]) {
      expect(parseState(bad), bad).toBeNull();
    }
  });
});

describe("client name", () => {
  it("keeps an ordinary name, in any script", () => {
    expect(sanitizeClientName("Modlight Desktop")).toBe("Modlight Desktop");
    expect(sanitizeClientName("Modlight Pulpit")).toBe("Modlight Pulpit");
  });

  it("strips bidirectional overrides and other invisibles", () => {
    // The reason this function exists. U+202E flips the text after it, so
    // "moc.live" reads as "evil.com" inside a permission prompt, with no
    // character a reader could point at as suspicious.
    expect(sanitizeClientName(`evil${RTL_OVERRIDE} moc.live`)).toBe("evil moc.live");
    expect(sanitizeClientName(`Mod${ZERO_WIDTH}light`)).toBe("Mod light");
    expect(sanitizeClientName(`Modlight${NBSP}`)).toBe("Modlight");
  });

  it("collapses whitespace so a name cannot push the prompt off screen", () => {
    expect(sanitizeClientName("Modlight\n\n\n\n\n\n\nDesktop")).toBe("Modlight Desktop");
  });

  it("truncates to a length a person can read", () => {
    expect(sanitizeClientName("x".repeat(500))).toHaveLength(CLIENT_NAME_MAX);
  });

  it("treats a missing or repeated name as no name at all", () => {
    expect(sanitizeClientName(undefined)).toBe("");
    expect(sanitizeClientName(["a", "b"])).toBe("");
    expect(sanitizeClientName("   ")).toBe("");
  });
});

describe("callback URL", () => {
  it("is built from the parsed number, so it can only ever be loopback", () => {
    expect(loopbackCallback(49732)).toBe("http://127.0.0.1:49732/");
  });

  it("throws rather than emit a URL for a port that never passed the parser", () => {
    // Belt and braces around the open redirect: a future caller that reaches
    // here with an unchecked value gets a crash, not a token posted to a host
    // of somebody else's choosing.
    expect(() => loopbackCallback(80)).toThrow();
    expect(() => loopbackCallback(70000)).toThrow();
    expect(() => loopbackCallback(8080.5)).toThrow();
    expect(() => loopbackCallback(Number.NaN)).toThrow();
  });
});

describe("whole request", () => {
  it("accepts a well-formed one and reports what it will do", () => {
    const parsed = parseAuthorizeRequest({
      port: "49732",
      state: "s7Kd93jf0aQ2",
      name: "Modlight Desktop",
    });

    expect(parsed).toEqual({
      ok: true,
      request: {
        port: 49732,
        state: "s7Kd93jf0aQ2",
        clientName: "Modlight Desktop",
        callback: "http://127.0.0.1:49732/",
      },
    });
  });

  it("still accepts a request with no client name", () => {
    // A name is a courtesy the prompt can fall back from; a port and a state
    // are the protocol.
    const parsed = parseAuthorizeRequest({ port: "49732", state: "s7Kd93jf0aQ2" });
    expect(parsed.ok && parsed.request.clientName).toBe("");
  });

  it("names which half of the request was wrong", () => {
    expect(parseAuthorizeRequest({ port: "80", state: "s7Kd93jf0aQ2" })).toEqual({
      ok: false,
      reason: "invalid-port",
    });
    expect(parseAuthorizeRequest({ port: "49732", state: "no" })).toEqual({
      ok: false,
      reason: "invalid-state",
    });
  });
});

describe("round trip through the sign-in redirect", () => {
  it("rebuilds a link that parses back to the same request", () => {
    // This is what `?next=` carries while the user signs in (and clears 2FA).
    // If it did not survive the round trip, the app would still be sitting on a
    // port nobody can name any more.
    const original = parseAuthorizeRequest({
      port: "49732",
      state: "s7Kd93jf0aQ2",
      name: "Modlight Desktop",
    });
    expect(original.ok).toBe(true);
    if (!original.ok) return;

    const path = authorizePath(original.request);
    const query = new URL(path, "https://example.test").searchParams;
    const again = parseAuthorizeRequest({
      port: query.get("port") ?? undefined,
      state: query.get("state") ?? undefined,
      name: query.get("name") ?? undefined,
    });

    expect(again).toEqual(original);
  });

  it("is a relative in-app path, which is what /login will accept", () => {
    // `safeNext` on the login page takes a path starting with a single slash.
    const parsed = parseAuthorizeRequest({ port: "49732", state: "s7Kd93jf0aQ2" });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const path = authorizePath(parsed.request);
    expect(path.startsWith("/authorize?")).toBe(true);
    expect(path.startsWith("//")).toBe(false);
  });
});

describe("token name", () => {
  it("marks where the token came from", () => {
    expect(tokenNameFor("Modlight Desktop")).toBe("Desktop: Modlight Desktop");
    expect(tokenNameFor("")).toBe("Desktop client");
  });

  it("fits the column, whatever the client calls itself", () => {
    // `api_tokens.name` is varchar(120): an over-long value is a failed INSERT,
    // which the user would experience as a sign-in that mysteriously does not
    // work rather than as a validation message.
    expect(tokenNameFor("y".repeat(400)).length).toBeLessThanOrEqual(TOKEN_NAME_MAX);
  });

  it("sanitizes again, because the name is client-supplied on this path too", () => {
    expect(tokenNameFor(`She${RTL_OVERRIDE}ll`)).toBe("Desktop: She ll");
  });
});
