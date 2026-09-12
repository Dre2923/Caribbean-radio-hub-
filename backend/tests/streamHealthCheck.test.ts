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
    const result = await checkStreamHealth(url);
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

    const result = await checkStreamHealth(url);

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
    const result = await checkStreamHealth(url, 200);
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
    const result = await checkStreamHealth("http://127.0.0.1:1", 1000);

    expect(result.isReachable).toBe(false);
    expect(result.statusCode).toBeNull();
    expect(result.error).not.toBeNull();
  });

  it("reports a malformed URL as unreachable rather than throwing", async () => {
    const result = await checkStreamHealth("not-a-url", 1000);

    expect(result.isReachable).toBe(false);
    expect(result.statusCode).toBeNull();
    expect(result.error).not.toBeNull();
  });
});
