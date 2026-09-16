// Step 60 (Reliability/Security/Monitoring, closing pass): src/index.ts is
// a genuinely side-effecting entrypoint script - importing it starts a
// real HTTP listener and three real background workers immediately, so
// it can't be exercised in-process via app.inject() the way every other
// route/behavior in this suite is. The only honest way to prove its own
// graceful-shutdown path actually works is to run it for real: spawn the
// compiled server as a real child process, confirm it's actually up, send
// it a real SIGTERM, and prove it exits cleanly rather than hanging or
// crashing - the same "verify the real thing, not a stand-in for it"
// standard this whole build already holds itself to for anything hard to
// simulate (e.g. tests/streamHealthCheck.test.ts's own real local servers).
//
// An honest, documented residual limitation of this test, found directly
// rather than assumed: it cannot prove shutdown()'s own `await
// pool.end()` line specifically ran, only that shutdown as a whole
// completes without hanging or throwing. Confirmed empirically by
// temporarily removing that exact line and re-running this test - it
// still passed, every time, because Node's own process.exit() closes the
// socket fast enough that Postgres notices the dropped connection
// essentially immediately regardless of whether pool.end() sent a real
// wire-protocol termination first. pool.end()'s real, narrower value (not
// leaving a genuinely in-flight background-worker query to be truncated
// mid-write by process.exit(), rather than "connections would otherwise
// linger") is a race condition too timing-sensitive to reproduce as a
// reliable, non-flaky automated test - the same class of judgment call as
// this codebase's own documented DNS-rebinding limitation in
// ssrfProtection.ts, stated plainly rather than papered over with a test
// that looks more thorough than it actually is.

import { describe, expect, it } from "vitest";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST_ENTRY = path.resolve(__dirname, "../dist/index.js");
const TEST_PORT = 3097;
const TEST_HOST = "127.0.0.1";

async function waitForHealthy(port: number, host: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const response = await fetch(`http://${host}:${port}/health`);
      if (response.ok) return;
    } catch {
      // Not accepting connections yet - keep polling.
    }
    if (Date.now() > deadline) {
      throw new Error(`Server at ${host}:${port} did not become healthy within ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

function waitForExit(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Process did not exit within ${timeoutMs}ms of SIGTERM`));
    }, timeoutMs);
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

describe("Graceful shutdown (Step 60)", () => {
  it("exits cleanly (code 0) on SIGTERM after a real DB-backed request, rather than hanging or crashing", async () => {
    const child = spawn("node", [DIST_ENTRY], {
      env: {
        ...process.env,
        PORT: String(TEST_PORT),
        HOST: TEST_HOST,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    try {
      await waitForHealthy(TEST_PORT, TEST_HOST, 10_000);

      // Exercise the pool for real before shutting down - proves the
      // shutdown sequence below runs against a pool that actually has an
      // open connection to close, not an empty one that was never used.
      const readiness = await fetch(`http://${TEST_HOST}:${TEST_PORT}/health/db`);
      expect(readiness.ok).toBe(true);

      child.kill("SIGTERM");
      const exitCode = await waitForExit(child, 8_000);

      // A non-zero/null exit here means shutdown() itself threw (e.g.
      // pool.end() rejecting because a client was never released) rather
      // than completing - exactly the class of regression a change to the
      // shutdown sequence could introduce, surfaced with the child's own
      // stderr for a real failure message instead of a silent code-1
      // with no context.
      expect(exitCode, `child stderr:\n${stderr}`).toBe(0);
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
    }
  }, 20_000);
});
