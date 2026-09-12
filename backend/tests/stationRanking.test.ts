import { afterAll, afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { pool } from "../src/db/pool.js";
import { setUserRole } from "../src/repositories/usersRepository.js";

afterAll(async () => {
  await pool.end();
});

// Ranking has no q= marker to filter by the way other endpoints' tests do
// (see Step 18/20's fixes for that pattern) - it's inherently "every
// active station in this country," so a test can never scope its
// assertions down to just the rows it created the way a search-filtered
// query could. Two layers of protection, both needed:
//
// 1. Every other test file in this build picks countries[0] (see
//    getRealCountryId elsewhere), which has accumulated well over a
//    thousand stations across this build's many local runs - these tests
//    use every *other* launch country instead, a country per test so
//    tests can't interfere with each other either.
// 2. That alone isn't enough: this file's *own* repeated local runs would
//    still accumulate stations in whichever of those countries it uses,
//    the identical problem just self-inflicted instead of inherited.
//    Every station this file creates is hard-deleted (cascading to its
//    health checks) in afterEach, so exact-order/exact-membership
//    assertions stay valid no matter how many times this file itself has
//    already run locally. (A one-time cleanup of this file's own earlier,
//    pre-this-fix debris - `DELETE FROM radio_stations WHERE name LIKE
//    'Ranking Station %'`, a distinctive marker only this file ever
//    used - was run once by hand to clear the slate; afterEach keeps it
//    that way going forward.)
let createdStationIds: number[] = [];

afterEach(async () => {
  if (createdStationIds.length > 0) {
    await pool.query("DELETE FROM radio_stations WHERE id = ANY($1)", [createdStationIds]);
    createdStationIds = [];
  }
});

let nextCountryIndex = 1;
async function getIsolatedCountryId(app: ReturnType<typeof buildApp>): Promise<number> {
  const response = await app.inject({ method: "GET", url: "/v1/countries" });
  const countries = response.json().countries as Array<{ id: number }>;
  const index = nextCountryIndex++;
  const country = countries[index];
  if (!country) throw new Error(`expected at least ${index + 1} seeded countries`);
  return country.id;
}

async function createAdminToken(app: ReturnType<typeof buildApp>, label: string): Promise<string> {
  const email = `ranking-admin-${label}-${Date.now()}@example.com`;
  const password = "ranking-admin-password-123";
  const register = await app.inject({
    method: "POST",
    url: "/v1/users",
    payload: { email, password, displayName: "Ranking Admin" },
  });
  const userId = register.json().user.id as number;
  await setUserRole(userId, "admin");

  const login = await app.inject({ method: "POST", url: "/v1/auth/login", payload: { email, password } });
  return login.json().token as string;
}

function uniqueStreamUrl(label: string): string {
  return `https://stream.example.com/${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

async function createStation(
  app: ReturnType<typeof buildApp>,
  adminToken: string,
  countryId: number,
  label: string,
): Promise<number> {
  const create = await app.inject({
    method: "POST",
    url: "/v1/stations",
    payload: { countryId, name: `Ranking Station ${label}`, streamUrl: uniqueStreamUrl(label) },
    headers: { authorization: `Bearer ${adminToken}` },
  });
  const stationId = create.json().station.id as number;
  createdStationIds.push(stationId);
  return stationId;
}

async function insertChecks(
  stationId: number,
  checks: Array<{ isReachable: boolean; latencyMs: number }>,
): Promise<void> {
  for (const check of checks) {
    await pool.query(
      `INSERT INTO station_health_checks (station_id, is_reachable, status_code, latency_ms, error)
       VALUES ($1, $2, $3, $4, $5)`,
      [stationId, check.isReachable, check.isReachable ? 200 : null, check.latencyMs, check.isReachable ? null : "down"],
    );
  }
}

describe("GET /v1/stations/ranked", () => {
  it("is a real, public, unauthenticated route - not shadowed by GET /v1/stations/:id", async () => {
    // Fastify/find-my-way always prefers an exact static match over a
    // parametric one at the same depth, but verified live rather than
    // assumed from routing theory alone: a request with no countryId at
    // all should hit this route's own querystring validation (400 for a
    // missing required field) and never GET /v1/stations/:id's integer
    // params check (which would also 400, but for the unrelated reason of
    // "ranked" not being a valid integer id - the wrong route entirely).
    const app = buildApp();
    const response = await app.inject({ method: "GET", url: "/v1/stations/ranked" });
    expect(response.statusCode).toBe(400);
    expect(response.json().message).toMatch(/countryId/);

    await app.close();
  });

  it("requires countryId", async () => {
    const app = buildApp();
    const response = await app.inject({ method: "GET", url: "/v1/stations/ranked?windowHours=24" });
    expect(response.statusCode).toBe(400);

    await app.close();
  });

  it("returns an empty list for a country with no active stations", async () => {
    const app = buildApp();
    const countryId = await getIsolatedCountryId(app);

    const response = await app.inject({ method: "GET", url: `/v1/stations/ranked?countryId=${countryId}` });
    expect(response.statusCode).toBe(200);
    expect(response.json().stations).toEqual([]);

    await app.close();
  });

  it("ranks a station with real high uptime ahead of one with real low uptime", async () => {
    const app = buildApp();
    const countryId = await getIsolatedCountryId(app);
    const adminToken = await createAdminToken(app, "high-low");

    const goodId = await createStation(app, adminToken, countryId, "good");
    const badId = await createStation(app, adminToken, countryId, "bad");
    await insertChecks(goodId, [
      { isReachable: true, latencyMs: 50 },
      { isReachable: true, latencyMs: 50 },
      { isReachable: true, latencyMs: 50 },
      { isReachable: false, latencyMs: 5000 },
    ]); // 75% uptime
    await insertChecks(badId, [
      { isReachable: true, latencyMs: 50 },
      { isReachable: false, latencyMs: 5000 },
      { isReachable: false, latencyMs: 5000 },
      { isReachable: false, latencyMs: 5000 },
    ]); // 25% uptime

    const response = await app.inject({ method: "GET", url: `/v1/stations/ranked?countryId=${countryId}` });
    const ids = (response.json().stations as Array<{ station: { id: number } }>).map(
      (entry) => entry.station.id,
    );
    expect(ids).toEqual([goodId, badId]);

    await app.close();
  });

  it("ranks a station with no recorded checks after every station with real data", async () => {
    const app = buildApp();
    const countryId = await getIsolatedCountryId(app);
    const adminToken = await createAdminToken(app, "unknown-last");

    const unknownId = await createStation(app, adminToken, countryId, "unknown");
    const knownBadId = await createStation(app, adminToken, countryId, "known-bad");
    // Even a station confirmed down every single time - real, measured
    // evidence - ranks ahead of one with no evidence at all.
    await insertChecks(knownBadId, [
      { isReachable: false, latencyMs: 5000 },
      { isReachable: false, latencyMs: 5000 },
    ]);

    const response = await app.inject({ method: "GET", url: `/v1/stations/ranked?countryId=${countryId}` });
    const ids = (response.json().stations as Array<{ station: { id: number } }>).map(
      (entry) => entry.station.id,
    );
    expect(ids).toEqual([knownBadId, unknownId]);
    const unknownEntry = (
      response.json().stations as Array<{ station: { id: number }; reliability: { uptimePercentage: number | null } }>
    ).find((entry) => entry.station.id === unknownId);
    expect(unknownEntry?.reliability.uptimePercentage).toBeNull();

    await app.close();
  });

  it("breaks an uptime tie with lower average latency", async () => {
    const app = buildApp();
    const countryId = await getIsolatedCountryId(app);
    const adminToken = await createAdminToken(app, "latency-tiebreak");

    const fastId = await createStation(app, adminToken, countryId, "fast");
    const slowId = await createStation(app, adminToken, countryId, "slow");
    // Both 100% uptime - only latency should decide the order.
    await insertChecks(fastId, [{ isReachable: true, latencyMs: 20 }]);
    await insertChecks(slowId, [{ isReachable: true, latencyMs: 400 }]);

    const response = await app.inject({ method: "GET", url: `/v1/stations/ranked?countryId=${countryId}` });
    const ids = (response.json().stations as Array<{ station: { id: number } }>).map(
      (entry) => entry.station.id,
    );
    expect(ids).toEqual([fastId, slowId]);

    await app.close();
  });

  it("excludes an inactive (curated-off) station entirely, regardless of its reliability", async () => {
    const app = buildApp();
    const countryId = await getIsolatedCountryId(app);
    const adminToken = await createAdminToken(app, "excludes-inactive");

    const activeId = await createStation(app, adminToken, countryId, "active");
    const inactiveId = await createStation(app, adminToken, countryId, "inactive");
    // The inactive one has a perfect track record - still must never appear.
    await insertChecks(inactiveId, [{ isReachable: true, latencyMs: 10 }]);
    await app.inject({
      method: "PATCH",
      url: `/v1/stations/${inactiveId}`,
      payload: { isActive: false },
      headers: { authorization: `Bearer ${adminToken}` },
    });

    const response = await app.inject({ method: "GET", url: `/v1/stations/ranked?countryId=${countryId}` });
    const ids = (response.json().stations as Array<{ station: { id: number } }>).map(
      (entry) => entry.station.id,
    );
    expect(ids).toEqual([activeId]);

    await app.close();
  });

  it("never includes a station from a different country", async () => {
    const app = buildApp();
    const countryA = await getIsolatedCountryId(app);
    const countryB = await getIsolatedCountryId(app);
    const adminToken = await createAdminToken(app, "cross-country");

    const stationAId = await createStation(app, adminToken, countryA, "country-a");
    await createStation(app, adminToken, countryB, "country-b");

    const response = await app.inject({ method: "GET", url: `/v1/stations/ranked?countryId=${countryA}` });
    const ids = (response.json().stations as Array<{ station: { id: number } }>).map(
      (entry) => entry.station.id,
    );
    expect(ids).toEqual([stationAId]);

    await app.close();
  });

  it("respects windowHours - a check outside the window doesn't count", async () => {
    const app = buildApp();
    const countryId = await getIsolatedCountryId(app);
    const adminToken = await createAdminToken(app, "window");

    const stationId = await createStation(app, adminToken, countryId, "window");
    await pool.query(
      `INSERT INTO station_health_checks (station_id, checked_at, is_reachable, status_code, latency_ms, error)
       VALUES ($1, now() - interval '30 hours', false, NULL, 100, 'stale')`,
      [stationId],
    );

    const defaultWindow = await app.inject({
      method: "GET",
      url: `/v1/stations/ranked?countryId=${countryId}`,
    });
    const defaultEntry = (
      defaultWindow.json().stations as Array<{
        station: { id: number };
        reliability: { uptimePercentage: number | null };
      }>
    )[0];
    expect(defaultEntry.reliability.uptimePercentage).toBeNull();

    const widerWindow = await app.inject({
      method: "GET",
      url: `/v1/stations/ranked?countryId=${countryId}&windowHours=48`,
    });
    const widerEntry = (
      widerWindow.json().stations as Array<{
        station: { id: number };
        reliability: { uptimePercentage: number | null };
      }>
    )[0];
    expect(widerEntry.reliability.uptimePercentage).toBe(0);

    await app.close();
  });

  it("rejects windowHours/limit outside their documented bounds", async () => {
    const app = buildApp();
    const countryId = await getIsolatedCountryId(app);

    const badWindow = await app.inject({
      method: "GET",
      url: `/v1/stations/ranked?countryId=${countryId}&windowHours=169`,
    });
    expect(badWindow.statusCode).toBe(400);

    const badLimit = await app.inject({
      method: "GET",
      url: `/v1/stations/ranked?countryId=${countryId}&limit=51`,
    });
    expect(badLimit.statusCode).toBe(400);

    await app.close();
  });

  it("caps the returned list at the requested limit, keeping the best-ranked entries", async () => {
    const app = buildApp();
    const countryId = await getIsolatedCountryId(app);
    const adminToken = await createAdminToken(app, "ranked-limit");

    const firstId = await createStation(app, adminToken, countryId, "limit-1");
    const secondId = await createStation(app, adminToken, countryId, "limit-2");
    await createStation(app, adminToken, countryId, "limit-3");
    await insertChecks(firstId, [{ isReachable: true, latencyMs: 10 }]);
    await insertChecks(secondId, [{ isReachable: true, latencyMs: 50 }]);
    // The third station is left with no checks, so it ranks last anyway.

    const response = await app.inject({
      method: "GET",
      url: `/v1/stations/ranked?countryId=${countryId}&limit=2`,
    });
    const ids = (response.json().stations as Array<{ station: { id: number } }>).map(
      (entry) => entry.station.id,
    );
    expect(ids).toEqual([firstId, secondId]);

    await app.close();
  });
});
