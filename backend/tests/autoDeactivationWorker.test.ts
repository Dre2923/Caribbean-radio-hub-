import { afterAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { pool } from "../src/db/pool.js";
import { setUserRole } from "../src/repositories/usersRepository.js";
import { findStationById } from "../src/repositories/stationsRepository.js";
import type { StationReliability } from "../src/repositories/stationHealthRepository.js";
import {
  shouldAutoDeactivate,
  evaluateStationsForAutoDeactivation,
} from "../src/stationHealth/autoDeactivationWorker.js";

afterAll(async () => {
  await pool.end();
});

function reliability(overrides: Partial<StationReliability>): StationReliability {
  return {
    stationId: 1,
    windowHours: 48,
    totalChecks: 0,
    reachableChecks: 0,
    uptimePercentage: null,
    averageLatencyMs: null,
    ...overrides,
  };
}

describe("shouldAutoDeactivate (Step 23)", () => {
  it("is false when there is no data yet (null uptime)", () => {
    expect(shouldAutoDeactivate(reliability({ totalChecks: 0, uptimePercentage: null }))).toBe(
      false,
    );
  });

  it("is false when uptime is 0% but the sample size is below the minimum", () => {
    expect(
      shouldAutoDeactivate(reliability({ totalChecks: 5, reachableChecks: 0, uptimePercentage: 0 })),
    ).toBe(false);
  });

  it("is false when uptime is any positive percentage, even with a large sample", () => {
    expect(
      shouldAutoDeactivate(
        reliability({ totalChecks: 100, reachableChecks: 1, uptimePercentage: 1 }),
      ),
    ).toBe(false);
  });

  it("is true only once uptime is exactly 0% with at least the minimum sample size", () => {
    expect(
      shouldAutoDeactivate(
        reliability({ totalChecks: 20, reachableChecks: 0, uptimePercentage: 0 }),
      ),
    ).toBe(true);
    expect(
      shouldAutoDeactivate(
        reliability({ totalChecks: 500, reachableChecks: 0, uptimePercentage: 0 }),
      ),
    ).toBe(true);
  });
});

async function getRealCountryId(app: ReturnType<typeof buildApp>): Promise<number> {
  const response = await app.inject({ method: "GET", url: "/v1/countries" });
  const countries = response.json().countries as Array<{ id: number }>;
  const country = countries[0];
  if (!country) throw new Error("expected at least one seeded country");
  return country.id;
}

async function createAdminToken(app: ReturnType<typeof buildApp>, label: string): Promise<string> {
  const email = `auto-deactivate-admin-${label}-${Date.now()}@example.com`;
  const password = "auto-deactivate-admin-password-123";
  const register = await app.inject({
    method: "POST",
    url: "/v1/users",
    payload: { email, password, displayName: "Auto Deactivate Admin" },
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
    payload: { countryId, name: `Auto Deactivate ${label}`, streamUrl: uniqueStreamUrl(label) },
    headers: { authorization: `Bearer ${adminToken}` },
  });
  return create.json().station.id as number;
}

async function insertChecks(
  stationId: number,
  count: number,
  isReachable: boolean,
): Promise<void> {
  for (let i = 0; i < count; i++) {
    await pool.query(
      `INSERT INTO station_health_checks (station_id, is_reachable, status_code, latency_ms, error)
       VALUES ($1, $2, $3, $4, $5)`,
      [stationId, isReachable, isReachable ? 200 : null, isReachable ? 50 : 5000, isReachable ? null : "down"],
    );
  }
}

async function getStationOrThrow(stationId: number) {
  const station = await findStationById(stationId);
  if (!station) throw new Error(`expected station ${stationId} to still exist`);
  return station;
}

// Exercises evaluateStationsForAutoDeactivation directly with a small,
// explicit id list rather than runAutoDeactivationSweep()'s real
// listActiveStationsForHealthCheck() catalog scan - the identical reason
// Step 20's sweepStations/runHealthCheckSweep tests do this (see that
// file's comment): the shared local test database accumulates real
// stations across every local run, and a genuine full-catalog scan would
// be slow and non-deterministic for a test that needs to assert exactly
// which stations were and weren't deactivated. Recognized proactively this
// time, before ever hitting the timeout Step 20 did.
describe("evaluateStationsForAutoDeactivation (Step 23)", () => {
  it("deactivates a station with 0% uptime across enough checks, attributed to no human admin", async () => {
    const app = buildApp();
    const countryId = await getRealCountryId(app);
    const adminToken = await createAdminToken(app, "deactivates");
    const stationId = await createStation(app, adminToken, countryId, "dead");
    await insertChecks(stationId, 25, false);

    await evaluateStationsForAutoDeactivation([stationId]);

    const station = await getStationOrThrow(stationId);
    expect(station.isActive).toBe(false);
    expect(station.deactivatedByUserId).toBeNull();
    expect(station.deactivationReason).toMatch(/Automatically deactivated/);
    expect(station.deactivationReason).toMatch(/25 checks/);

    await app.close();
  });

  it("does not deactivate a station below the minimum check count, even at 0% uptime", async () => {
    const app = buildApp();
    const countryId = await getRealCountryId(app);
    const adminToken = await createAdminToken(app, "too-few-checks");
    const stationId = await createStation(app, adminToken, countryId, "sparse");
    await insertChecks(stationId, 3, false);

    await evaluateStationsForAutoDeactivation([stationId]);

    const station = await getStationOrThrow(stationId);
    expect(station.isActive).toBe(true);

    await app.close();
  });

  it("does not deactivate a station with any successful checks, even mostly down", async () => {
    const app = buildApp();
    const countryId = await getRealCountryId(app);
    const adminToken = await createAdminToken(app, "mostly-down");
    const stationId = await createStation(app, adminToken, countryId, "flaky");
    await insertChecks(stationId, 24, false);
    await insertChecks(stationId, 1, true);

    await evaluateStationsForAutoDeactivation([stationId]);

    const station = await getStationOrThrow(stationId);
    expect(station.isActive).toBe(true);

    await app.close();
  });

  it("evaluates multiple stations independently in one call", async () => {
    const app = buildApp();
    const countryId = await getRealCountryId(app);
    const adminToken = await createAdminToken(app, "multi");
    const deadId = await createStation(app, adminToken, countryId, "multi-dead");
    const healthyId = await createStation(app, adminToken, countryId, "multi-healthy");
    await insertChecks(deadId, 25, false);
    await insertChecks(healthyId, 25, true);

    await evaluateStationsForAutoDeactivation([deadId, healthyId]);

    const dead = await getStationOrThrow(deadId);
    const healthy = await getStationOrThrow(healthyId);
    expect(dead.isActive).toBe(false);
    expect(healthy.isActive).toBe(true);

    await app.close();
  });

  it("skips an evaluation that starts while one is already in progress", async () => {
    const app = buildApp();
    const countryId = await getRealCountryId(app);
    const adminToken = await createAdminToken(app, "overlap");
    const stationId = await createStation(app, adminToken, countryId, "overlap");
    await insertChecks(stationId, 25, false);

    // Called back-to-back, synchronously: the in-progress flag is set
    // before evaluateStationsForAutoDeactivation's first await, so the
    // second call sees it already true and returns immediately -
    // deterministic given JS's run-to-first-await semantics.
    const first = evaluateStationsForAutoDeactivation([stationId]);
    const second = evaluateStationsForAutoDeactivation([stationId]);
    await Promise.all([first, second]);

    const station = await getStationOrThrow(stationId);
    expect(station.isActive).toBe(false);

    await app.close();
  });
});
