// Step 58/OWASP API7:2023 (Server-Side Request Forgery) - this backend
// makes exactly one outbound request whose destination is admin-supplied
// rather than a fixed, trusted third party: checkStreamHealth
// (streamHealthCheck.ts) connects to a station's own `streamUrl`, set at
// station creation/update (POST/PATCH /v1/stations, admin-only) and
// re-fetched automatically every few minutes by the background health-
// check worker (Step 20). OWASP's own API7 guidance treats this exact
// shape - a server-side request to a URL the caller controls - as SSRF
// risk even when the caller is a trusted/authenticated role, not only for
// anonymous public input: an admin account being phished, a compromised
// admin credential, or simply a typo/copy-paste mistake could otherwise
// point this backend's own outbound request at an internal service or a
// cloud metadata endpoint (e.g. 169.254.169.254) it should never be able
// to reach.
//
// Uses Node's own built-in net.BlockList (core since Node 15, well before
// this project's >=20 engines requirement - verified via nodejs.org's own
// docs during this step's research rather than assumed) instead of a
// third-party SSRF-guard npm package: several exist, but none carry the
// kind of maturity/adoption signal this build has required before
// depending on anything else (nodemailer, prom-client's official
// successor) - a built-in, zero-dependency primitive is the stronger,
// more defensible choice here. BlockList.check() transparently handles
// IPv4-mapped IPv6 addresses (e.g. ::ffff:127.0.0.1) once IPv4 rules are
// registered, per Node's own documented example - no manual address
// normalization needed.
import { BlockList, isIP } from "node:net";
import { lookup as dnsLookup } from "node:dns/promises";

const PRIVATE_NETWORK_BLOCKLIST = new BlockList();

// IPv4: loopback, current-network, link-local (includes the AWS/GCP/Azure
// cloud metadata address 169.254.169.254), the three RFC 1918 private
// ranges, and the documented "special-purpose" CGNAT/benchmarking ranges.
PRIVATE_NETWORK_BLOCKLIST.addSubnet("127.0.0.0", 8);
PRIVATE_NETWORK_BLOCKLIST.addSubnet("0.0.0.0", 8);
PRIVATE_NETWORK_BLOCKLIST.addSubnet("169.254.0.0", 16);
PRIVATE_NETWORK_BLOCKLIST.addSubnet("10.0.0.0", 8);
PRIVATE_NETWORK_BLOCKLIST.addSubnet("172.16.0.0", 12);
PRIVATE_NETWORK_BLOCKLIST.addSubnet("192.168.0.0", 16);
PRIVATE_NETWORK_BLOCKLIST.addSubnet("100.64.0.0", 10); // carrier-grade NAT
PRIVATE_NETWORK_BLOCKLIST.addSubnet("198.18.0.0", 15); // benchmarking

// IPv6: loopback, unique local (fc00::/7), and link-local (fe80::/10) -
// the IPv6 analogs of the IPv4 ranges above.
PRIVATE_NETWORK_BLOCKLIST.addAddress("::1", "ipv6");
PRIVATE_NETWORK_BLOCKLIST.addSubnet("fc00::", 7, "ipv6");
PRIVATE_NETWORK_BLOCKLIST.addSubnet("fe80::", 10, "ipv6");

export class SsrfBlockedHostError extends Error {
  constructor(hostname: string, address: string) {
    super(`Refusing to connect to ${hostname} - resolves to a private/reserved network address (${address})`);
    this.name = "SsrfBlockedHostError";
  }
}

// Resolves every address a hostname currently maps to (dns.lookup with
// all:true, not just the first result a round-robin DNS record might
// return) and rejects if *any* of them fall inside a private/reserved
// range - a hostname that resolves to both a public and an internal
// address is treated as unsafe, not given the benefit of the doubt.
//
// Known, deliberate limitation (documented rather than silently assumed
// away): this validates the hostname immediately before use, but the
// underlying fetch() call re-resolves DNS independently when it actually
// connects. A sophisticated attacker controlling DNS for the target
// hostname with a near-zero TTL could in principle swap the record
// between this check and the connection (classic "DNS rebinding").
// Fully closing that requires pinning the validated IP at the socket/
// dispatcher layer (a custom undici Agent), which is disproportionate
// complexity for what remains an admin-authenticated-only input surface
// (this project's real threat model here), not anonymous public input -
// this check still closes the realistic cases (a literal internal IP or
// metadata-endpoint hostname, and a redirect to one - see
// followRedirectsSafely in streamHealthCheck.ts) and is an honest,
// intentional scope boundary rather than a false sense of complete safety.
export async function assertPublicHostname(hostname: string): Promise<void> {
  // A literal IP address in the URL never goes through DNS at all -
  // checked directly rather than passed to dns.lookup, which would
  // reject a non-hostname input on some platforms.
  const literalFamily = isIP(hostname);
  if (literalFamily !== 0) {
    const type = literalFamily === 6 ? "ipv6" : "ipv4";
    if (PRIVATE_NETWORK_BLOCKLIST.check(hostname, type)) {
      throw new SsrfBlockedHostError(hostname, hostname);
    }
    return;
  }

  const addresses = await dnsLookup(hostname, { all: true, verbatim: true });
  for (const { address, family } of addresses) {
    const type = family === 6 ? "ipv6" : "ipv4";
    if (PRIVATE_NETWORK_BLOCKLIST.check(address, type)) {
      throw new SsrfBlockedHostError(hostname, address);
    }
  }
}
