import { createServer, type Server } from "node:http";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import { pool } from "../src/db/pool.js";
import { setUserRole } from "../src/repositories/usersRepository.js";

// Step 58/OWASP API7: see the identical comment in
// tests/healthCheckWorker.test.ts - checkStreamHealth's real default now
// refuses a loopback target, exactly what this file's own real local test
// servers bind to. Mocked at the module level so this file keeps proving
// what it's actually for (the admin health-check route's own request/
// response wiring and history-recording), not re-proving the SSRF guard
// itself, which tests/ssrfProtection.test.ts already covers exhaustively
// without mocking anything. The real route/worker code never overrides
// this in production.
vi.mock("../src/utils/ssrfProtection.js", () => ({
  assertPublicHostname: vi.fn().mockResolvedValue(undefined),
}));

afterAll(async () => {
  await pool.end();
});

// createStation (below) never tracked what it created, so every local run
// of this file left its stations (and, for the "reachable" test
// specifically, a real ephemeral-port stream_url) permanently in the
// shared test database forever - found the hard way when a later run's
// OS-assigned port collided with an old, never-cleaned-up row and hit
// radio_stations' UNIQUE(stream_url) constraint (Step 12). Fixed here:
// mirroring every other test file's own createdStationIds + top-level
// afterEach pattern, deleting the 1096-row backlog this gap had already
// accumulated (`DELETE FROM radio_stations WHERE name LIKE 'Health Check
// Station %'`, a marker only this file has ever used) as a one-time
// cleanup, then keeping it that way going forward.
let createdStationIds: number[] = [];

afterEach(async () => {
  if (createdStationIds.length > 0) {
    await pool.query("DELETE FROM radio_stations WHERE id = ANY($1)", [createdStationIds]);
    createdStationIds = [];
  }
});

async function getRealCountryId(app: ReturnType<typeof buildApp>): Promise<number> {
  const response = await app.inject({ method: "GET", url: "/v1/countries" });
  const countries = response.json().countries as Array<{ id: number }>;
  const country = countries[0];
  if (!country) throw new Error("expected at least one seeded country");
  return country.id;
}

async function createAdminToken(app: ReturnType<typeof buildApp>, label: string): Promise<string> {
  const email = `station-health-admin-${label}-${Date.now()}@example.com`;
  const password = "station-health-admin-password-123";
  const register = await app.inject({
    method: "POST",
    url: "/v1/users",
    payload: { email, password, displayName: "Station Health Admin" },
  });
  const userId = register.json().user.id as number;
  await setUserRole(userId, "admin");

  const login = await app.inject({ method: "POST", url: "/v1/auth/login", payload: { email, password } });
  return login.json().token as string;
}

async function createRegularToken(app: ReturnType<typeof buildApp>, label: string): Promise<string> {
  const email = `station-health-user-${label}-${Date.now()}@example.com`;
  const password = "station-health-user-password-123";
  await app.inject({
    method: "POST",
    url: "/v1/users",
    payload: { email, password, displayName: "Station Health Regular User" },
  });
  const login = await app.inject({ method: "POST", url: "/v1/auth/login", payload: { email, password } });
  return login.json().token as string;
}

function uniqueStreamUrl(label: string): string {
  return `https://stream.example.com/${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

// A real, live loopback address with nothing listening on it - a genuine
// connection-refused, not a simulated one. The path is unique per call
// only to satisfy radio_stations.stream_url's own UNIQUE constraint
// (Step 12) across multiple tests/updates in the same run; connection
// failure happens at the TCP level, before the path is ever relevant.
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
    payload: { countryId, name: `Health Check Station ${Date.now()}`, streamUrl },
    headers: { authorization: `Bearer ${adminToken}` },
  });
  const stationId = create.json().station.id as number;
  createdStationIds.push(stationId);
  return stationId;
}

describe("POST /v1/admin/stations/:id/health-check", () => {
  let server: Server | undefined;

  afterEach(async () => {
    if (server) {
      await close(server);
      server = undefined;
    }
  });

  it("rejects with no token, and with a non-admin token", async () => {
    const app = buildApp();
    const countryId = await getRealCountryId(app);
    const adminToken = await createAdminToken(app, "auth-setup");
    const stationId = await createStation(app, adminToken, countryId, uniqueStreamUrl("auth"));

    const noToken = await app.inject({
      method: "POST",
      url: `/v1/admin/stations/${stationId}/health-check`,
    });
    expect(noToken.statusCode).toBe(401);

    const regularToken = await createRegularToken(app, "auth");
    const nonAdmin = await app.inject({
      method: "POST",
      url: `/v1/admin/stations/${stationId}/health-check`,
      headers: { authorization: `Bearer ${regularToken}` },
    });
    expect(nonAdmin.statusCode).toBe(403);

    await app.close();
  });

  it("returns 404 for an unknown station id", async () => {
    const app = buildApp();
    const adminToken = await createAdminToken(app, "notfound");

    const response = await app.inject({
      method: "POST",
      url: "/v1/admin/stations/999999999/health-check",
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(response.statusCode).toBe(404);

    await app.close();
  });

  it("runs a real check against a live stream and records it as reachable", async () => {
    const app = buildApp();
    const countryId = await getRealCountryId(app);
    const adminToken = await createAdminToken(app, "reachable");

    server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "audio/mpeg" });
      const interval = setInterval(() => res.write(Buffer.alloc(512, 0)), 10);
      res.on("close", () => clearInterval(interval));
    });
    const streamUrl = await listen(server);
    const stationId = await createStation(app, adminToken, countryId, uniqueStreamUrl("reachable"));
    // The catalog itself only accepts HTTPS stream URLs (createStation's
    // schema) - directly exercise the repository/route path against the
    // real local HTTP test server instead, since a self-signed local HTTPS
    // server would add certificate-trust complexity unrelated to what this
    // test is actually proving (that a real live server is genuinely
    // reached and recorded, not that the app enforces HTTPS - already
    // covered elsewhere).
    await pool.query("UPDATE radio_stations SET stream_url = $1 WHERE id = $2", [streamUrl, stationId]);

    const response = await app.inject({
      method: "POST",
      url: `/v1/admin/stations/${stationId}/health-check`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(response.statusCode).toBe(201);
    const healthCheck = response.json().healthCheck;
    expect(healthCheck.stationId).toBe(stationId);
    expect(healthCheck.isReachable).toBe(true);
    expect(healthCheck.statusCode).toBe(200);
    expect(healthCheck.error).toBeNull();
    expect(typeof healthCheck.latencyMs).toBe("number");

    await app.close();
  });

  it("runs a real check against a dead endpoint and records it as unreachable", async () => {
    const app = buildApp();
    const countryId = await getRealCountryId(app);
    const adminToken = await createAdminToken(app, "unreachable");
    const stationId = await createStation(app, adminToken, countryId, uniqueStreamUrl("unreachable"));
    await pool.query("UPDATE radio_stations SET stream_url = $1 WHERE id = $2", [
      uniqueDeadStreamUrl("unreachable"),
      stationId,
    ]);

    const response = await app.inject({
      method: "POST",
      url: `/v1/admin/stations/${stationId}/health-check`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(response.statusCode).toBe(201);
    const healthCheck = response.json().healthCheck;
    expect(healthCheck.isReachable).toBe(false);
    expect(healthCheck.statusCode).toBeNull();
    expect(healthCheck.error).not.toBeNull();

    await app.close();
  });

  it("also works for an inactive (curated-off) station", async () => {
    const app = buildApp();
    const countryId = await getRealCountryId(app);
    const adminToken = await createAdminToken(app, "inactive");
    const stationId = await createStation(app, adminToken, countryId, uniqueStreamUrl("inactive"));
    await app.inject({
      method: "PATCH",
      url: `/v1/stations/${stationId}`,
      payload: { isActive: false },
      headers: { authorization: `Bearer ${adminToken}` },
    });

    const response = await app.inject({
      method: "POST",
      url: `/v1/admin/stations/${stationId}/health-check`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    // The station's own real streamUrl is a placeholder example.com
    // address in this test - unreachable, but the point being proven is
    // that the route itself doesn't 404/block on an inactive station, only
    // on a genuinely unknown id.
    expect(response.statusCode).toBe(201);

    await app.close();
  });
});

describe("GET /v1/admin/stations/:id/health-checks", () => {
  it("rejects with no token, and with a non-admin token", async () => {
    const app = buildApp();
    const countryId = await getRealCountryId(app);
    const adminToken = await createAdminToken(app, "list-auth-setup");
    const stationId = await createStation(app, adminToken, countryId, uniqueStreamUrl("list-auth"));

    const noToken = await app.inject({
      method: "GET",
      url: `/v1/admin/stations/${stationId}/health-checks`,
    });
    expect(noToken.statusCode).toBe(401);

    const regularToken = await createRegularToken(app, "list-auth");
    const nonAdmin = await app.inject({
      method: "GET",
      url: `/v1/admin/stations/${stationId}/health-checks`,
      headers: { authorization: `Bearer ${regularToken}` },
    });
    expect(nonAdmin.statusCode).toBe(403);

    await app.close();
  });

  it("returns 404 for an unknown station id", async () => {
    const app = buildApp();
    const adminToken = await createAdminToken(app, "list-notfound");

    const response = await app.inject({
      method: "GET",
      url: "/v1/admin/stations/999999999/health-checks",
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(response.statusCode).toBe(404);

    await app.close();
  });

  it("lists recorded checks most-recent-first", async () => {
    const app = buildApp();
    const countryId = await getRealCountryId(app);
    const adminToken = await createAdminToken(app, "list-history");
    const stationId = await createStation(app, adminToken, countryId, uniqueStreamUrl("list-history"));
    await pool.query("UPDATE radio_stations SET stream_url = $1 WHERE id = $2", [
      uniqueDeadStreamUrl("list-history"),
      stationId,
    ]);

    // Two checks, run one after another - both against the same dead
    // endpoint, so both are guaranteed distinguishable only by checkedAt.
    const first = await app.inject({
      method: "POST",
      url: `/v1/admin/stations/${stationId}/health-check`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    const second = await app.inject({
      method: "POST",
      url: `/v1/admin/stations/${stationId}/health-check`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    const firstId = first.json().healthCheck.id as number;
    const secondId = second.json().healthCheck.id as number;

    const list = await app.inject({
      method: "GET",
      url: `/v1/admin/stations/${stationId}/health-checks`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(list.statusCode).toBe(200);
    const ids = (list.json().healthChecks as Array<{ id: number }>).map((h) => h.id);
    // Most-recent-first: the second (later) check appears before the first.
    expect(ids.indexOf(secondId)).toBeLessThan(ids.indexOf(firstId));

    await app.close();
  });

  it("caps the returned history at the requested limit", async () => {
    const app = buildApp();
    const countryId = await getRealCountryId(app);
    const adminToken = await createAdminToken(app, "list-limit");
    const stationId = await createStation(app, adminToken, countryId, uniqueStreamUrl("list-limit"));
    await pool.query("UPDATE radio_stations SET stream_url = $1 WHERE id = $2", [
      uniqueDeadStreamUrl("list-limit"),
      stationId,
    ]);

    for (let i = 0; i < 3; i++) {
      await app.inject({
        method: "POST",
        url: `/v1/admin/stations/${stationId}/health-check`,
        headers: { authorization: `Bearer ${adminToken}` },
      });
    }

    const limited = await app.inject({
      method: "GET",
      url: `/v1/admin/stations/${stationId}/health-checks?limit=2`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(limited.statusCode).toBe(200);
    expect(limited.json().healthChecks).toHaveLength(2);

    await app.close();
  });

  it("rejects a limit above the documented maximum", async () => {
    const app = buildApp();
    const adminToken = await createAdminToken(app, "list-limit-invalid");

    const response = await app.inject({
      method: "GET",
      url: "/v1/admin/stations/1/health-checks?limit=101",
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(response.statusCode).toBe(400);

    await app.close();
  });
});

describe("GET /v1/admin/stations/:id/reliability (Step 21)", () => {
  it("rejects with no token, and with a non-admin token", async () => {
    const app = buildApp();
    const countryId = await getRealCountryId(app);
    const adminToken = await createAdminToken(app, "reliability-auth-setup");
    const stationId = await createStation(app, adminToken, countryId, uniqueStreamUrl("reliability-auth"));

    const noToken = await app.inject({
      method: "GET",
      url: `/v1/admin/stations/${stationId}/reliability`,
    });
    expect(noToken.statusCode).toBe(401);

    const regularToken = await createRegularToken(app, "reliability-auth");
    const nonAdmin = await app.inject({
      method: "GET",
      url: `/v1/admin/stations/${stationId}/reliability`,
      headers: { authorization: `Bearer ${regularToken}` },
    });
    expect(nonAdmin.statusCode).toBe(403);

    await app.close();
  });

  it("returns 404 for an unknown station id", async () => {
    const app = buildApp();
    const adminToken = await createAdminToken(app, "reliability-notfound");

    const response = await app.inject({
      method: "GET",
      url: "/v1/admin/stations/999999999/reliability",
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(response.statusCode).toBe(404);

    await app.close();
  });

  it("returns null uptime/latency with zero counts when no checks are recorded yet", async () => {
    const app = buildApp();
    const countryId = await getRealCountryId(app);
    const adminToken = await createAdminToken(app, "reliability-empty");
    const stationId = await createStation(app, adminToken, countryId, uniqueStreamUrl("reliability-empty"));

    const response = await app.inject({
      method: "GET",
      url: `/v1/admin/stations/${stationId}/reliability`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().reliability).toEqual({
      stationId,
      windowHours: 24,
      totalChecks: 0,
      reachableChecks: 0,
      uptimePercentage: null,
      averageLatencyMs: null,
    });

    await app.close();
  });

  it("computes uptime percentage and average latency across reachable checks only", async () => {
    const app = buildApp();
    const countryId = await getRealCountryId(app);
    const adminToken = await createAdminToken(app, "reliability-mixed");
    const stationId = await createStation(app, adminToken, countryId, uniqueStreamUrl("reliability-mixed"));

    // 3 reachable (latencies 10, 20, 30 -> average 20) + 1 unreachable.
    // Inserted directly rather than through a real network check - this
    // test is about the aggregation math, already isolated from
    // checkStreamHealth's own behavior (covered in
    // tests/streamHealthCheck.test.ts).
    await pool.query(
      `INSERT INTO station_health_checks (station_id, is_reachable, status_code, latency_ms, error)
       VALUES ($1, true, 200, 10, NULL), ($1, true, 200, 20, NULL),
              ($1, true, 200, 30, NULL), ($1, false, NULL, 5000, 'timeout')`,
      [stationId],
    );

    const response = await app.inject({
      method: "GET",
      url: `/v1/admin/stations/${stationId}/reliability`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(response.statusCode).toBe(200);
    const reliability = response.json().reliability;
    expect(reliability.totalChecks).toBe(4);
    expect(reliability.reachableChecks).toBe(3);
    expect(reliability.uptimePercentage).toBe(75);
    expect(reliability.averageLatencyMs).toBe(20);

    await app.close();
  });

  it("returns 0% uptime (not null) when every check in the window failed", async () => {
    const app = buildApp();
    const countryId = await getRealCountryId(app);
    const adminToken = await createAdminToken(app, "reliability-alldown");
    const stationId = await createStation(app, adminToken, countryId, uniqueStreamUrl("reliability-alldown"));

    await pool.query(
      `INSERT INTO station_health_checks (station_id, is_reachable, status_code, latency_ms, error)
       VALUES ($1, false, NULL, 100, 'refused'), ($1, false, NULL, 120, 'refused')`,
      [stationId],
    );

    const response = await app.inject({
      method: "GET",
      url: `/v1/admin/stations/${stationId}/reliability`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    const reliability = response.json().reliability;
    expect(reliability.totalChecks).toBe(2);
    expect(reliability.uptimePercentage).toBe(0);
    // No reachable checks at all - nothing to average.
    expect(reliability.averageLatencyMs).toBeNull();

    await app.close();
  });

  it("excludes checks outside the requested window", async () => {
    const app = buildApp();
    const countryId = await getRealCountryId(app);
    const adminToken = await createAdminToken(app, "reliability-window");
    const stationId = await createStation(app, adminToken, countryId, uniqueStreamUrl("reliability-window"));

    // One check 30 hours ago (outside a 24h window), one just now.
    await pool.query(
      `INSERT INTO station_health_checks (station_id, checked_at, is_reachable, status_code, latency_ms, error)
       VALUES ($1, now() - interval '30 hours', false, NULL, 100, 'stale')`,
      [stationId],
    );
    await pool.query(
      `INSERT INTO station_health_checks (station_id, is_reachable, status_code, latency_ms, error)
       VALUES ($1, true, 200, 50, NULL)`,
      [stationId],
    );

    const defaultWindow = await app.inject({
      method: "GET",
      url: `/v1/admin/stations/${stationId}/reliability`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(defaultWindow.json().reliability.totalChecks).toBe(1);
    expect(defaultWindow.json().reliability.uptimePercentage).toBe(100);

    const widerWindow = await app.inject({
      method: "GET",
      url: `/v1/admin/stations/${stationId}/reliability?windowHours=48`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(widerWindow.json().reliability.totalChecks).toBe(2);
    expect(widerWindow.json().reliability.uptimePercentage).toBe(50);

    await app.close();
  });

  it("rejects a windowHours outside the documented bounds", async () => {
    const app = buildApp();
    const adminToken = await createAdminToken(app, "reliability-window-invalid");

    const zero = await app.inject({
      method: "GET",
      url: "/v1/admin/stations/1/reliability?windowHours=0",
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(zero.statusCode).toBe(400);

    const tooWide = await app.inject({
      method: "GET",
      url: "/v1/admin/stations/1/reliability?windowHours=169",
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(tooWide.statusCode).toBe(400);

    await app.close();
  });
});
