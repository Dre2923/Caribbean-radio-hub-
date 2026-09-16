// Step 63 (Production QA): this backend's own fail-fast startup checks
// (config/env.ts's requiredJwtSecret, resolveMetricsToken) already have
// unit tests for the pure functions themselves (tests/metrics.test.ts),
// but nothing had ever actually spawned the real compiled entrypoint to
// confirm the process itself refuses to boot when they'd fail - and,
// checked directly against .github/workflows/backend-ci.yml, this whole
// build has NEVER run its own compiled server with NODE_ENV=production
// even once (CI always sets NODE_ENV: test) despite Step 58 adding
// production-only enforcement (METRICS_TOKEN) specifically for that mode,
// and config/env.ts's own frontendUrl() requiring FRONTEND_URL in
// production too. A step named Production QA finding "production mode
// itself has never actually been run" is exactly the class of gap this
// step exists to catch - the same "verify the real thing, not a
// stand-in for it" standard tests/gracefulShutdown.test.ts already
// applies to shutdown.
//
// A real trap found and worked around while writing this file: env.ts
// does `import "dotenv/config"`, which loads backend/.env for any
// variable not already present in the process's own environment. This
// repo's real .env has a real JWT_SECRET in it for local development, so
// simply omitting JWT_SECRET from a spawned child's env object is not
// enough to simulate "genuinely unset" - dotenv silently backfills it
// from .env the moment the child starts, since the child's cwd defaults
// to this same directory. Confirmed directly (a first version of the
// no-JWT_SECRET test below hung waiting for a non-zero exit that never
// came) rather than assumed. The fix: spawn that one child with cwd set
// to a directory with no .env file at all, so there's nothing for dotenv
// to silently fill the gap with - the same "prove the real absence, not
// a value that happens to still resolve" standard as everything else in
// this build.
//
// FRONTEND_URL is required in production (used to build the password-
// reset email link) but isn't set in this repo's own .env - a second
// genuine, previously-never-exercised production requirement this file
// found directly while trying to write an unrelated test, not one that
// was already known before writing this file.

import { describe, expect, it } from "vitest";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST_ENTRY = path.resolve(__dirname, "../dist/index.js");
const TEST_HOST = "127.0.0.1";

// A real value good enough to satisfy frontendUrl()'s own validation
// (it's just used to build a link, never dereferenced by this test) -
// supplied explicitly in every test below that isn't itself testing
// FRONTEND_URL's own requiredness, so each test isolates exactly one
// failure condition rather than tripping over an unrelated one.
const REAL_FRONTEND_URL = "https://qa.example.com";

function spawnServer(
  env: Record<string, string | undefined>,
  options: { cwd?: string } = {},
): ChildProcessWithoutNullStreams {
  return spawn("node", [DIST_ENTRY], {
    env: env as NodeJS.ProcessEnv,
    cwd: options.cwd ?? __dirname,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function captureStderr(child: ChildProcessWithoutNullStreams): { get text(): string } {
  let text = "";
  child.stderr.on("data", (chunk: Buffer) => {
    text += chunk.toString();
  });
  return {
    get text() {
      return text;
    },
  };
}

function waitForExit(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Process did not exit within ${timeoutMs}ms`));
    }, timeoutMs);
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

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

async function killIfAlive(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
  }
}

describe("Fail-fast startup validation (Step 63)", () => {
  it("refuses to start with no JWT_SECRET at all", async () => {
    const envWithoutSecret = { ...process.env, FRONTEND_URL: REAL_FRONTEND_URL };
    delete envWithoutSecret.JWT_SECRET;
    // cwd: tmpdir() - see this file's own header comment for why omitting
    // JWT_SECRET from the env object alone isn't enough.
    const child = spawnServer(
      { ...envWithoutSecret, PORT: "3096", HOST: TEST_HOST },
      { cwd: tmpdir() },
    );
    const stderr = captureStderr(child);
    try {
      const exitCode = await waitForExit(child, 5_000);
      expect(exitCode, `stderr:\n${stderr.text}`).not.toBe(0);
      expect(stderr.text).toContain("JWT_SECRET");
    } finally {
      await killIfAlive(child);
    }
  }, 10_000);

  it("refuses to start with a JWT_SECRET shorter than the documented minimum", async () => {
    const child = spawnServer({
      ...process.env,
      FRONTEND_URL: REAL_FRONTEND_URL,
      JWT_SECRET: "too-short",
      PORT: "3096",
      HOST: TEST_HOST,
    });
    const stderr = captureStderr(child);
    try {
      const exitCode = await waitForExit(child, 5_000);
      expect(exitCode, `stderr:\n${stderr.text}`).not.toBe(0);
      expect(stderr.text).toContain("JWT_SECRET must be at least");
    } finally {
      await killIfAlive(child);
    }
  }, 10_000);

  it("refuses to start in production mode with no FRONTEND_URL configured", async () => {
    // No cwd trick needed here - unlike JWT_SECRET, this repo's real .env
    // genuinely has no FRONTEND_URL line at all (confirmed directly), so
    // dotenv has nothing to backfill it with regardless of cwd.
    const child = spawnServer({
      ...process.env,
      NODE_ENV: "production",
      METRICS_TOKEN: "irrelevant-to-this-test",
      PORT: "3096",
      HOST: TEST_HOST,
    });
    const stderr = captureStderr(child);
    try {
      const exitCode = await waitForExit(child, 5_000);
      expect(exitCode, `stderr:\n${stderr.text}`).not.toBe(0);
      expect(stderr.text).toContain("FRONTEND_URL");
    } finally {
      await killIfAlive(child);
    }
  }, 10_000);

  it("refuses to start in production mode with no METRICS_TOKEN configured", async () => {
    const envWithoutToken = { ...process.env, FRONTEND_URL: REAL_FRONTEND_URL };
    delete envWithoutToken.METRICS_TOKEN;
    const child = spawnServer({
      ...envWithoutToken,
      NODE_ENV: "production",
      PORT: "3096",
      HOST: TEST_HOST,
    });
    const stderr = captureStderr(child);
    try {
      const exitCode = await waitForExit(child, 5_000);
      expect(exitCode, `stderr:\n${stderr.text}`).not.toBe(0);
      expect(stderr.text).toContain("METRICS_TOKEN");
    } finally {
      await killIfAlive(child);
    }
  }, 10_000);
});

describe("Real production-mode boot (Step 63)", () => {
  it("starts and serves real traffic under NODE_ENV=production with full required config, gating /metrics and /docs correctly", async () => {
    const metricsToken = "qa-production-boot-token-0123456789";
    const child = spawnServer({
      ...process.env,
      NODE_ENV: "production",
      FRONTEND_URL: REAL_FRONTEND_URL,
      METRICS_TOKEN: metricsToken,
      PORT: "3096",
      HOST: TEST_HOST,
    });
    const stderr = captureStderr(child);

    try {
      await waitForHealthy(3096, TEST_HOST, 10_000);

      const health = await fetch(`http://${TEST_HOST}:3096/health`);
      expect(health.status, `stderr:\n${stderr.text}`).toBe(200);

      // Production's own enable-only-with-a-flag posture for API docs
      // (config/env.ts's enableApiDocs) - confirmed live, not just read
      // from source, that /docs is genuinely unavailable in this mode by
      // default.
      const docs = await fetch(`http://${TEST_HOST}:3096/docs/json`);
      expect(docs.status).toBe(404);

      // /metrics genuinely enforces the configured token in this mode -
      // both the rejecting and accepting paths, against the real running
      // process, not the isolated pure-function unit tests this already
      // had (tests/metrics.test.ts).
      const unauthorized = await fetch(`http://${TEST_HOST}:3096/metrics`);
      expect(unauthorized.status).toBe(401);

      const authorized = await fetch(`http://${TEST_HOST}:3096/metrics`, {
        headers: { Authorization: `Bearer ${metricsToken}` },
      });
      expect(authorized.status).toBe(200);
      const body = await authorized.text();
      expect(body).toContain("process_cpu_user_seconds_total");

      child.kill("SIGTERM");
      const exitCode = await waitForExit(child, 8_000);
      expect(exitCode, `stderr:\n${stderr.text}`).toBe(0);
    } finally {
      await killIfAlive(child);
    }
  }, 25_000);
});
