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

describe("app.authenticate", () => {
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
