import { createServer, type Server } from "node:http";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import { pool } from "../src/db/pool.js";
import { setUserRole } from "../src/repositories/usersRepository.js";
import { listActiveStationsForHealthCheck } from "../src/repositories/stationsRepository.js";
import { listHealthChecks } from "../src/repositories/stationHealthRepository.js";
import { sweepStations } from "../src/stationHealth/healthCheckWorker.js";

// Step 58/OWASP API7: checkStreamHealth's real default now refuses to
// connect to a loopback/private-network target (ssrfProtection.ts) -
// exactly what every test server in this file binds to, being real local
// HTTP servers rather than mocks (this file's own top-of-suite reasoning).
// Mocked here at the module level rather than by threading a test-only
// parameter through sweepStations/the worker - this file's job is
// proving the sweep loop's own behavior (concurrency, overlap-guarding,
// error isolation across a target list), which is orthogonal to whether
// a given target's hostname is publicly routable; that real check is
// proven separately and exhaustively in tests/ssrfProtection.test.ts and
// tests/streamHealthCheck.test.ts's own dedicated SSRF suite, neither of
// which mocks anything. No production code path is affected either way -
// sweepStations/checkStreamHealth's own real default is never overridden
// outside this test file.
vi.mock("../src/utils/ssrfProtection.js", () => ({
  assertPublicHostname: vi.fn().mockResolvedValue(undefined),
}));

afterAll(async () => {
  await pool.end();
});

async function getRealCountryId(app: ReturnType<typeof buildApp>): Promise<number> {
  const response = await app.inject({ method: "GET", url: "/v1/countries" });
  const countries = response.json().countries as Array<{ id: number }>;
  const country = countries[0];
  if (!country) throw new Error("expected at least one seeded country");
  return country.id;
}

async function createAdminToken(app: ReturnType<typeof buildApp>, label: string): Promise<string> {
  const email = `health-worker-admin-${label}-${Date.now()}@example.com`;
  const password = "health-worker-admin-password-123";
  const register = await app.inject({
    method: "POST",
    url: "/v1/users",
    payload: { email, password, displayName: "Health Worker Admin" },
  });
  const userId = register.json().user.id as number;
  await setUserRole(userId, "admin");

  const login = await app.inject({ method: "POST", url: "/v1/auth/login", payload: { email, password } });
  return login.json().token as string;
}

function uniqueStreamUrl(label: string): string {
  return `https://stream.example.com/${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function uniqueDeadStreamUrl(label: string): string {
  return `http://127.0.0.1:1/${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

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

async function createStation(
  app: ReturnType<typeof buildApp>,
  adminToken: string,
  countryId: number,
  streamUrl: string,
): Promise<number> {
  const create = await app.inject({
    method: "POST",
    url: "/v1/stations",
    payload: { countryId, name: `Health Worker Station ${Date.now()}`, streamUrl },
    headers: { authorization: `Bearer ${adminToken}` },
  });
  return create.json().station.id as number;
}

describe("listActiveStationsForHealthCheck (Step 20)", () => {
  it("includes an active station and excludes an inactive one, by real streamUrl match", async () => {
    const app = buildApp();
    const countryId = await getRealCountryId(app);
    const adminToken = await createAdminToken(app, "list-active");
    const activeStreamUrl = uniqueStreamUrl("worker-active");
    const inactiveStreamUrl = uniqueStreamUrl("worker-inactive");

    const activeId = await createStation(app, adminToken, countryId, activeStreamUrl);
    const inactiveId = await createStation(app, adminToken, countryId, inactiveStreamUrl);
    await app.inject({
      method: "PATCH",
      url: `/v1/stations/${inactiveId}`,
      payload: { isActive: false },
      headers: { authorization: `Bearer ${adminToken}` },
    });

    const targets = await listActiveStationsForHealthCheck();
    const byId = new Map(targets.map((t) => [t.id, t]));

    expect(byId.get(activeId)?.streamUrl).toBe(activeStreamUrl);
    expect(byId.has(inactiveId)).toBe(false);

    await app.close();
  });
});

// Exercises sweepStations directly with a small, explicitly-controlled
// target list rather than runHealthCheckSweep()'s real
// listActiveStationsForHealthCheck() catalog scan. The real local test
// database this suite runs against accumulates rows across every local
// `npm test` invocation over the life of this build (see Step 18's
// tests/stations.test.ts fix for the same lesson) - by now well over a
// thousand of them, most pointed at the non-resolving "stream.example.com"
// placeholder domain, which would make a real full-catalog sweep take tens
// of seconds per test run. sweepStations is the actual worker logic
// (concurrency limiting, the overlap guard, per-station error isolation);
// runHealthCheckSweep is a one-line composition of it with the real
// listing query, already covered by listActiveStationsForHealthCheck's own
// test above.
describe("sweepStations (Step 20)", () => {
  let servers: Server[] = [];

  afterEach(async () => {
    await Promise.all(servers.map((server) => close(server)));
    servers = [];
  });

  it("checks and records every given station, independently of each other's outcome", async () => {
    const app = buildApp();
    const countryId = await getRealCountryId(app);
    const adminToken = await createAdminToken(app, "sweep-mixed");

    const reachableServer = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "audio/mpeg" });
      res.end();
    });
    servers.push(reachableServer);
    const reachableUrl = await listen(reachableServer);

    const reachableId = await createStation(app, adminToken, countryId, uniqueStreamUrl("sweep-reachable"));
    const unreachableId = await createStation(
      app,
      adminToken,
      countryId,
      uniqueStreamUrl("sweep-unreachable"),
    );

    await sweepStations([
      { id: reachableId, streamUrl: reachableUrl },
      { id: unreachableId, streamUrl: uniqueDeadStreamUrl("sweep-unreachable") },
    ]);

    const reachableChecks = await listHealthChecks(reachableId);
    const unreachableChecks = await listHealthChecks(unreachableId);
    expect(reachableChecks[0]?.isReachable).toBe(true);
    expect(unreachableChecks[0]?.isReachable).toBe(false);

    await app.close();
  });

  it("checks every station even when there are more of them than the concurrency limit", async () => {
    const app = buildApp();
    const countryId = await getRealCountryId(app);
    const adminToken = await createAdminToken(app, "sweep-many");

    const server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "audio/mpeg" });
      res.end();
    });
    servers.push(server);
    const url = await listen(server);

    // More targets than the worker's internal concurrency limit (5), to
    // prove the bounded worker-pool pattern doesn't silently drop or skip
    // any item beyond the first batch. Real catalog rows are required -
    // recordHealthCheck's insert has a real foreign key to radio_stations -
    // each with its own unique streamUrl (radio_stations.stream_url's own
    // UNIQUE constraint) but all pointing at the same real local server,
    // distinguished only by path, which the server ignores.
    const targets: Array<{ id: number; streamUrl: string }> = [];
    for (let i = 0; i < 8; i++) {
      const id = await createStation(app, adminToken, countryId, uniqueStreamUrl(`sweep-many-${i}`));
      targets.push({ id, streamUrl: `${url}/${i}` });
    }

    await sweepStations(targets);

    for (const target of targets) {
      const checks = await listHealthChecks(target.id);
      expect(checks).toHaveLength(1);
      expect(checks[0].isReachable).toBe(true);
    }

    await app.close();
  });

  it("skips a sweep that starts while one is already in progress, rather than running both", async () => {
    const app = buildApp();
    const countryId = await getRealCountryId(app);
    const adminToken = await createAdminToken(app, "sweep-overlap");

    const server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "audio/mpeg" });
      res.end();
    });
    servers.push(server);
    const url = await listen(server);
    const stationId = await createStation(app, adminToken, countryId, uniqueStreamUrl("sweep-overlap"));
    const target = { id: stationId, streamUrl: url };

    // Called back-to-back, synchronously, with no await in between: the
    // in-progress flag is set before sweepStations's first await, so the
    // second call sees it already true and returns immediately without
    // running a second sweep - deterministic given JS's run-to-first-await
    // semantics, not a timing-dependent race.
    const first = sweepStations([target]);
    const second = sweepStations([target]);
    await Promise.all([first, second]);

    const checks = await listHealthChecks(target.id);
    expect(checks).toHaveLength(1);

    await app.close();
  });
});
