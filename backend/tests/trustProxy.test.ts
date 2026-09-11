import { describe, expect, it } from "vitest";
import { parseTrustProxy } from "../src/config/env.js";
import { resolveTrustProxy } from "../src/app.js";

describe("parseTrustProxy (TRUST_PROXY env var)", () => {
  it("defaults to false (untrusted) when unset", () => {
    expect(parseTrustProxy(undefined)).toBe(false);
  });

  it("parses explicit false/true", () => {
    expect(parseTrustProxy("false")).toBe(false);
    expect(parseTrustProxy("true")).toBe(true);
  });

  it("parses a positive integer as a hop count", () => {
    expect(parseTrustProxy("2")).toBe(2);
  });

  it("treats zero and negative numbers as not a valid hop count", () => {
    // A real deployment behind at least one proxy needs >=1; 0/negative
    // falling through to the string branch (rather than silently becoming
    // `false`/untrusted or `true`/trust-everyone) surfaces a bad config
    // instead of masking it as one of those two very different behaviors.
    expect(parseTrustProxy("0")).toBe("0");
    expect(parseTrustProxy("-1")).toBe("-1");
  });

  it("passes through a non-numeric value (IP/CIDR list) unchanged", () => {
    expect(parseTrustProxy("10.0.0.1,10.0.0.2")).toBe("10.0.0.1,10.0.0.2");
  });
});

describe("resolveTrustProxy (hop-count -> Fastify trust function)", () => {
  it("passes booleans and strings through unchanged", () => {
    expect(resolveTrustProxy(true)).toBe(true);
    expect(resolveTrustProxy(false)).toBe(false);
    expect(resolveTrustProxy("10.0.0.1")).toBe("10.0.0.1");
  });

  it("trusts exactly the configured number of hops", () => {
    // hop is 0-indexed from the address nearest our server outward; proxy-addr
    // walks the chain while trust(addr, hop) returns true and stops (treating
    // that address as the real client) at the first hop it returns false for.
    // Trusting N hops means true for hops 0..N-1 and false starting at hop N.
    const trustTwoHops = resolveTrustProxy(2);
    expect(typeof trustTwoHops).toBe("function");
    if (typeof trustTwoHops !== "function") throw new Error("expected a function");

    expect(trustTwoHops("1.1.1.1", 0)).toBe(true);
    expect(trustTwoHops("1.1.1.1", 1)).toBe(true);
    expect(trustTwoHops("1.1.1.1", 2)).toBe(false);
    expect(trustTwoHops("1.1.1.1", 3)).toBe(false);
  });

  it("trusts zero hops for a single configured proxy", () => {
    const trustOneHop = resolveTrustProxy(1);
    if (typeof trustOneHop !== "function") throw new Error("expected a function");

    expect(trustOneHop("1.1.1.1", 0)).toBe(true);
    expect(trustOneHop("1.1.1.1", 1)).toBe(false);
  });
});
