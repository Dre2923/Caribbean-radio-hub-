import { describe, expect, it } from "vitest";
import { assertPublicHostname, SsrfBlockedHostError } from "../src/utils/ssrfProtection.js";

describe("assertPublicHostname (Step 58, OWASP API7: SSRF)", () => {
  describe("literal IPv4 addresses", () => {
    it("blocks loopback (127.0.0.0/8)", async () => {
      await expect(assertPublicHostname("127.0.0.1")).rejects.toThrow(SsrfBlockedHostError);
    });

    it("blocks the cloud-metadata-endpoint address (169.254.169.254)", async () => {
      await expect(assertPublicHostname("169.254.169.254")).rejects.toThrow(SsrfBlockedHostError);
    });

    it("blocks all three RFC 1918 private ranges", async () => {
      await expect(assertPublicHostname("10.1.2.3")).rejects.toThrow(SsrfBlockedHostError);
      await expect(assertPublicHostname("172.20.0.1")).rejects.toThrow(SsrfBlockedHostError);
      await expect(assertPublicHostname("192.168.1.1")).rejects.toThrow(SsrfBlockedHostError);
    });

    it("blocks the current-network address (0.0.0.0/8)", async () => {
      await expect(assertPublicHostname("0.0.0.0")).rejects.toThrow(SsrfBlockedHostError);
    });

    it("allows a real public IP address", async () => {
      await expect(assertPublicHostname("8.8.8.8")).resolves.toBeUndefined();
    });
  });

  describe("literal IPv6 addresses", () => {
    it("blocks loopback (::1)", async () => {
      await expect(assertPublicHostname("::1")).rejects.toThrow(SsrfBlockedHostError);
    });

    it("blocks unique-local addresses (fc00::/7)", async () => {
      await expect(assertPublicHostname("fd12:3456:789a::1")).rejects.toThrow(SsrfBlockedHostError);
    });

    it("blocks link-local addresses (fe80::/10)", async () => {
      await expect(assertPublicHostname("fe80::1")).rejects.toThrow(SsrfBlockedHostError);
    });

    it("blocks an IPv4-mapped IPv6 loopback address (::ffff:127.0.0.1)", async () => {
      await expect(assertPublicHostname("::ffff:127.0.0.1")).rejects.toThrow(SsrfBlockedHostError);
    });

    it("allows a real public IPv6 address", async () => {
      await expect(assertPublicHostname("2001:4860:4860::8888")).resolves.toBeUndefined();
    });
  });

  describe("hostnames resolved via real DNS lookup", () => {
    it("blocks 'localhost' - a real hostname that resolves to a loopback address on any system", async () => {
      // A genuine, deterministic hostname-resolution case (not a literal
      // IP) rather than a mocked DNS response - proving the dns.lookup
      // code path itself, not just the literal-IP fast path above.
      await expect(assertPublicHostname("localhost")).rejects.toThrow(SsrfBlockedHostError);
    });
  });

  it("includes the resolved address in the error message for a clear audit trail", async () => {
    await expect(assertPublicHostname("127.0.0.1")).rejects.toThrow(/127\.0\.0\.1/);
  });
});
