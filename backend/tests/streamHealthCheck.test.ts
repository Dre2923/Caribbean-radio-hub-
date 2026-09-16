import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { checkStreamHealth } from "../src/utils/streamHealthCheck.js";

// Real HTTP servers, not mocks - this exercises actual sockets and actual
// timing behavior (a never-ending response body, a connection that never
// responds at all), the same "verify against something real" standard
// applied to every other integration test in this build, just without a
// dependency on any actual external Caribbean radio stream existing yet.

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("expected a real TCP address from an ephemeral port");
  }
  return `http://127.0.0.1:${address.port}`;
}

function close(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

// Step 58/OWASP API7: checkStreamHealth's real, default hostname
// validator (ssrfProtection.ts's assertPublicHostname) correctly refuses
// loopback by default in production - exactly what every test server in
// this file binds to. Every call below explicitly passes this permissive
// no-op instead, the same "override the real dependency for a test that
// needs to reach a local server" pattern already used for FcmPushProvider's
// injected FetchLike - the real default itself is tested separately, in
// "checkStreamHealth SSRF protection (Step 58)" below.
const ALLOW_ALL_HOSTNAMES = async () => undefined;

describe("checkStreamHealth (Step 19)", () => {
  let server: Server | undefined;

  afterEach(async () => {
    if (server) {
      await close(server);
      server = undefined;
    }
  });

  it("reports a live, indefinitely-streaming server as reachable without waiting for the stream to end", async () => {
    let keepStreaming = true;
    server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "audio/mpeg" });
      const interval = setInterval(() => {
        if (!keepStreaming) {
          clearInterval(interval);
          return;
        }
        res.write(Buffer.alloc(1024, 0));
      }, 10);
      res.on("close", () => clearInterval(interval));
    });
    const url = await listen(server);

    const startedAt = Date.now();
    const result = await checkStreamHealth(url, undefined, ALLOW_ALL_HOSTNAMES);
    const elapsedMs = Date.now() - startedAt;
    keepStreaming = false;

    expect(result.isReachable).toBe(true);
    expect(result.statusCode).toBe(200);
    expect(result.error).toBeNull();
    // The server would happily stream forever - resolving quickly proves
    // the response body was cancelled rather than read to completion.
    expect(elapsedMs).toBeLessThan(2000);
  });

  it("reports a non-2xx status as unreachable", async () => {
    server = createServer((_req, res) => {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
    });
    const url = await listen(server);

    const result = await checkStreamHealth(url, undefined, ALLOW_ALL_HOSTNAMES);

    expect(result.isReachable).toBe(false);
    expect(result.statusCode).toBe(404);
    expect(result.error).toBeNull();
  });

  it("times out against a server that accepts the connection but never responds", async () => {
    server = createServer(() => {
      // Never call res.write/res.end - simulates a stalled/hung server.
    });
    const url = await listen(server);

    const startedAt = Date.now();
    const result = await checkStreamHealth(url, 200, ALLOW_ALL_HOSTNAMES);
    const elapsedMs = Date.now() - startedAt;

    expect(result.isReachable).toBe(false);
    expect(result.statusCode).toBeNull();
    expect(result.error).not.toBeNull();
    expect(elapsedMs).toBeGreaterThanOrEqual(150);
    expect(elapsedMs).toBeLessThan(2000);
  });

  it("reports a refused connection as unreachable with a real error message", async () => {
    // A port nothing is listening on, on the loopback address - a real
    // connection-refused, not a simulated one.
    const result = await checkStreamHealth("http://127.0.0.1:1", 1000, ALLOW_ALL_HOSTNAMES);

    expect(result.isReachable).toBe(false);
    expect(result.statusCode).toBeNull();
    expect(result.error).not.toBeNull();
  });

  it("reports a malformed URL as unreachable rather than throwing", async () => {
    const result = await checkStreamHealth("not-a-url", 1000, ALLOW_ALL_HOSTNAMES);

    expect(result.isReachable).toBe(false);
    expect(result.statusCode).toBeNull();
    expect(result.error).not.toBeNull();
  });

  it("follows a real redirect to another allowed host and reports the final response", async () => {
    let target: Server | undefined;
    try {
      target = createServer((_req, res) => {
        res.writeHead(200, { "content-type": "audio/mpeg" });
        res.end();
      });
      const targetUrl = await listen(target);

      server = createServer((_req, res) => {
        res.writeHead(302, { Location: targetUrl });
        res.end();
      });
      const redirectingUrl = await listen(server);

      const result = await checkStreamHealth(redirectingUrl, undefined, ALLOW_ALL_HOSTNAMES);

      expect(result.isReachable).toBe(true);
      expect(result.statusCode).toBe(200);
    } finally {
      if (target) await close(target);
    }
  });
});

describe("checkStreamHealth SSRF protection (Step 58, OWASP API7)", () => {
  it("refuses a loopback stream URL by default - not given the benefit of the doubt", async () => {
    // No permissive validator passed here - this is the real, default
    // behavior every production call site actually gets.
    const result = await checkStreamHealth("http://127.0.0.1:1/stream", 1000);

    expect(result.isReachable).toBe(false);
    expect(result.statusCode).toBeNull();
    expect(result.error).toMatch(/private\/reserved network address/);
  });

  it("refuses a literal cloud-metadata-endpoint address (169.254.169.254) by default", async () => {
    const result = await checkStreamHealth("http://169.254.169.254/latest/meta-data/", 1000);

    expect(result.isReachable).toBe(false);
    expect(result.error).toMatch(/private\/reserved network address/);
  });

  it("refuses a redirect to a blocked address, even from an allowed starting host", async () => {
    let server: Server | undefined;
    try {
      server = createServer((_req, res) => {
        res.writeHead(302, { Location: "http://169.254.169.254/latest/meta-data/" });
        res.end();
      });
      const url = await listen(server);

      // The starting host (127.0.0.1) is explicitly allowed here so this
      // test isolates the redirect-hop check specifically, not the
      // starting-host check already covered above.
      const result = await checkStreamHealth(url, 1000, async (hostname) => {
        if (hostname === "169.254.169.254") {
          throw new Error("Refusing to connect - resolves to a private/reserved network address");
        }
      });

      expect(result.isReachable).toBe(false);
      expect(result.error).toMatch(/private\/reserved network address/);
    } finally {
      if (server) await close(server);
    }
  });
});
