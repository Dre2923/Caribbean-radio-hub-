import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";

// Regression test for a real bug found while building this test, not a
// hypothetical: app.authenticate's catch block called
// `reply.status(401).send(...)` without `return`-ing it. `reply.sent` is a
// getter over the raw response's `writableEnded` - an asynchronous I/O
// condition - so a preHandler that manually sends from a catch block can
// have its promise resolve, and Fastify's "is this handled?" check run,
// before the write actually completes, letting the protected route
// handler execute anyway. Confirmed by reproducing it (findUserById was
// actually called with an unverified token's claims) before switching to
// letting jwtVerify's rejection propagate as a thrown error instead -
// which is structurally race-free (see the comment on app.authenticate in
// src/app.ts for why).
//
// Tampering note: flipping only the JWT's last character is not a
// reliable way to corrupt an HS256 signature - a 32-byte HMAC-SHA256
// output's last base64url character carries 2 "don't-care" padding bits,
// so some single-character edits there decode to the exact same bytes and
// the "tampered" token verifies as valid. Confirmed directly: encoding 32
// zero bytes and swapping the final character between every possible
// value that only changes those padding bits produces identical decoded
// bytes. This corrupts a character from the middle of the signature
// instead, which always changes a byte that JWT verification actually
// checks.
function tamperSignature(token: string): string {
  const parts = token.split(".");
  const signature = parts[2];
  const midpoint = Math.floor(signature.length / 2);
  const midChar = signature[midpoint];
  const replacement = midChar === "A" ? "B" : "A";
  parts[2] = signature.slice(0, midpoint) + replacement + signature.slice(midpoint + 1);
  return parts.join(".");
}

// Builds a syntactically well-formed but unsigned/garbage-signed JWT with
// an arbitrary header, for exercising verification-failure paths that
// don't require actually knowing JWT_SECRET.
function forgeToken(header: Record<string, unknown>, payload: Record<string, unknown>): string {
  const encode = (obj: unknown) => Buffer.from(JSON.stringify(obj)).toString("base64url");
  return `${encode(header)}.${encode(payload)}.forged-signature`;
}

describe("app.authenticate", () => {
  // Regression test for a real bug found via live adversarial testing of a
  // running server, not a hypothetical: @fastify/jwt only converts 4 of
  // fast-jwt's ~15 verification-failure codes (expired, invalid
  // signature/key/claim, missing signature) into its own proper-401
  // FastifyError - everything else, including an invalid `alg` header (the
  // classic "alg: none" JWT forgery technique), passes through as a raw
  // error with no `statusCode` at all. The app's generic error handler
  // (src/app.ts) defaulted that to 500 - a hostile/malformed token got
  // treated as the server's own bug (logged at "error", not "warn") rather
  // than correctly rejected as unauthorized. Fixed by recognizing any
  // FAST_JWT_* error code as a 401 regardless of whether the library
  // itself attached a statusCode.
  it("rejects a forged token with an invalid alg header as 401, not 500", async () => {
    const app = buildApp();
    await app.ready();

    const forged = forgeToken({ alg: "none", typ: "JWT" }, { sub: 1, email: "nobody@example.com" });
    const response = await app.inject({
      method: "GET",
      url: "/v1/me",
      headers: { authorization: `Bearer ${forged}` },
    });

    expect(response.statusCode).toBe(401);
    await app.close();
  });

  it("rejects a forged token with a nonsense alg header as 401, not 500", async () => {
    const app = buildApp();
    await app.ready();

    const forged = forgeToken(
      { alg: "definitely-not-a-real-algorithm", typ: "JWT" },
      { sub: 1, email: "nobody@example.com" },
    );
    const response = await app.inject({
      method: "GET",
      url: "/v1/me",
      headers: { authorization: `Bearer ${forged}` },
    });

    expect(response.statusCode).toBe(401);
    await app.close();
  });

  it("rejects a token that claims a supported-elsewhere HMAC variant we don't accept", async () => {
    // HS384/HS512 are algorithms fast-jwt would accept by default for a
    // plain secret key if this app hadn't explicitly pinned verification
    // to HS256 (see app.ts) - forging a valid signature in either variant
    // still requires JWT_SECRET either way, so this isn't a bypass either
    // way, but the header claim alone should never even get that far.
    const app = buildApp();
    await app.ready();

    const forged = forgeToken({ alg: "HS384", typ: "JWT" }, { sub: 1, email: "nobody@example.com" });
    const response = await app.inject({
      method: "GET",
      url: "/v1/me",
      headers: { authorization: `Bearer ${forged}` },
    });

    expect(response.statusCode).toBe(401);
    await app.close();
  });

  it("rejects a token whose signature was tampered mid-string", async () => {
    const app = buildApp();
    await app.ready();

    const forgedToken = await app.jwt.sign({ sub: 1, email: "nobody@example.com" });
    const tampered = tamperSignature(forgedToken);
    expect(tampered).not.toBe(forgedToken);

    const response = await app.inject({
      method: "GET",
      url: "/v1/me",
      headers: { authorization: `Bearer ${tampered}` },
    });

    expect(response.statusCode).toBe(401);
    await app.close();
  });

  it("never lets an invalid token reach the protected handler, under concurrent load", async () => {
    const app = buildApp();
    await app.ready();

    const forgedToken = await app.jwt.sign({ sub: 1, email: "nobody@example.com" });
    const tampered = tamperSignature(forgedToken);

    // Kept under the API's global 100/min rate limit (app.ts) so a 429
    // never muddies the signal here - the fix is structural, not
    // probabilistic, so this concurrency is a regression guard against a
    // similar bug being reintroduced, not a requirement for the fix itself.
    const CONCURRENT_REQUESTS = 80;
    const responses = await Promise.all(
      Array.from({ length: CONCURRENT_REQUESTS }, () =>
        app.inject({
          method: "GET",
          url: "/v1/me",
          headers: { authorization: `Bearer ${tampered}` },
        }),
      ),
    );

    const statusCodes = responses.map((r) => r.statusCode);
    const nonUnauthorized = statusCodes.filter((code) => code !== 401);

    expect(nonUnauthorized).toEqual([]);
    await app.close();
  });
});
