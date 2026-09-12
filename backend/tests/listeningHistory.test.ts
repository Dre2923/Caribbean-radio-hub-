import { afterAll, afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { pool } from "../src/db/pool.js";
import { setUserRole } from "../src/repositories/usersRepository.js";

afterAll(async () => {
  await pool.end();
});

// No q=-style marker exists on this table to scope a test through - the
// same shape of gap Step 51's favorites.test.ts already documents.
// afterEach hard-deletion (of every station/user this file creates - which
// cascades listening_history rows via the migration's own FKs) is the
// entire correctness guarantee here.
let createdStationIds: number[] = [];
let createdUserIds: number[] = [];
let nextCountryOffset = 0;

afterEach(async () => {
  if (createdStationIds.length > 0) {
    await pool.query("DELETE FROM radio_stations WHERE id = ANY($1)", [createdStationIds]);
    createdStationIds = [];
  }
  if (createdUserIds.length > 0) {
    await pool.query("DELETE FROM users WHERE id = ANY($1)", [createdUserIds]);
    createdUserIds = [];
  }
});

async function getIsolatedCountryId(app: ReturnType<typeof buildApp>): Promise<number> {
  const response = await app.inject({ method: "GET", url: "/v1/countries" });
  const countries = response.json().countries as Array<{ id: number }>;
  const usableCountries = countries.slice(1);
  if (usableCountries.length === 0) throw new Error("expected at least 2 seeded countries");
  const country = usableCountries[nextCountryOffset % usableCountries.length];
  nextCountryOffset++;
  return country.id;
}

async function createAdminToken(app: ReturnType<typeof buildApp>, label: string): Promise<string> {
  const email = `history-admin-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
  const password = "history-admin-password-123";
  const register = await app.inject({
    method: "POST",
    url: "/v1/users",
    payload: { email, password, displayName: "History Admin" },
  });
  const userId = register.json().user.id as number;
  createdUserIds.push(userId);
  await setUserRole(userId, "admin");
  const login = await app.inject({ method: "POST", url: "/v1/auth/login", payload: { email, password } });
  return login.json().token as string;
}

async function createRegularAccount(
  app: ReturnType<typeof buildApp>,
  label: string,
): Promise<{ token: string; userId: number }> {
  const email = `history-user-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
  const password = "history-user-password-123";
  const register = await app.inject({
    method: "POST",
    url: "/v1/users",
    payload: { email, password, displayName: "History Regular User" },
  });
  const userId = register.json().user.id as number;
  createdUserIds.push(userId);
  const login = await app.inject({ method: "POST", url: "/v1/auth/login", payload: { email, password } });
  return { token: login.json().token as string, userId };
}

async function createStation(
  app: ReturnType<typeof buildApp>,
  options: { countryId: number; adminToken: string; name: string },
): Promise<number> {
  const response = await app.inject({
    method: "POST",
    url: "/v1/stations",
    payload: {
      countryId: options.countryId,
      name: options.name,
      streamUrl: `https://stream.example.com/${Date.now()}-${Math.random().toString(36).slice(2)}`,
    },
    headers: { authorization: `Bearer ${options.adminToken}` },
  });
  expect(response.statusCode).toBe(201);
  const stationId = response.json().station.id as number;
  createdStationIds.push(stationId);
  return stationId;
}

describe("Listening history", () => {
  it("requires authentication for every listening-history route", async () => {
    const app = buildApp();
    const post = await app.inject({ method: "POST", url: "/v1/me/listening-history", payload: { stationId: 1 } });
    expect(post.statusCode).toBe(401);
    const list = await app.inject({ method: "GET", url: "/v1/me/listening-history" });
    expect(list.statusCode).toBe(401);
    const del = await app.inject({ method: "DELETE", url: "/v1/me/listening-history" });
    expect(del.statusCode).toBe(401);
    await app.close();
  });

  it("records a listen and lists it back, hydrated with the station", async () => {
    const app = buildApp();
    const countryId = await getIsolatedCountryId(app);
    const adminToken = await createAdminToken(app, "record");
    const { token } = await createRegularAccount(app, "record");
    const marker = `History Station ${Date.now()}${Math.random().toString(36).slice(2)}`;
    const stationId = await createStation(app, { countryId, adminToken, name: marker });

    const record = await app.inject({
      method: "POST",
      url: "/v1/me/listening-history",
      payload: { stationId },
      headers: { authorization: `Bearer ${token}` },
    });
    expect(record.statusCode).toBe(201);
    const recordBody = record.json();
    expect(recordBody.entry.station.id).toBe(stationId);
    expect(typeof recordBody.entry.listenedAt).toBe("string");

    const list = await app.inject({
      method: "GET",
      url: "/v1/me/listening-history",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(list.statusCode).toBe(200);
    const body = list.json();
    expect(body.entries).toHaveLength(1);
    expect(body.entries[0].station.name).toBe(marker);
    expect(body.pagination.total).toBe(1);

    await app.close();
  });

  it("returns 400 recording a listen for an unknown stationId", async () => {
    const app = buildApp();
    const { token } = await createRegularAccount(app, "unknown-station");

    const response = await app.inject({
      method: "POST",
      url: "/v1/me/listening-history",
      payload: { stationId: 99999999 },
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().message).toContain("stationId");

    await app.close();
  });

  it("records the same station more than once - history is a log, not a set", async () => {
    const app = buildApp();
    const countryId = await getIsolatedCountryId(app);
    const adminToken = await createAdminToken(app, "repeat");
    const { token } = await createRegularAccount(app, "repeat");
    const stationId = await createStation(app, { countryId, adminToken, name: `History Repeat ${Date.now()}` });

    for (let i = 0; i < 3; i++) {
      const response = await app.inject({
        method: "POST",
        url: "/v1/me/listening-history",
        payload: { stationId },
        headers: { authorization: `Bearer ${token}` },
      });
      expect(response.statusCode).toBe(201);
    }

    const list = await app.inject({
      method: "GET",
      url: "/v1/me/listening-history",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(list.json().entries).toHaveLength(3);
    expect(list.json().pagination.total).toBe(3);

    await app.close();
  });

  it("orders most-recently-listened first", async () => {
    const app = buildApp();
    const countryId = await getIsolatedCountryId(app);
    const adminToken = await createAdminToken(app, "order");
    const { token } = await createRegularAccount(app, "order");
    const firstId = await createStation(app, { countryId, adminToken, name: `History Order First ${Date.now()}` });
    const secondId = await createStation(app, { countryId, adminToken, name: `History Order Second ${Date.now()}` });

    await app.inject({
      method: "POST",
      url: "/v1/me/listening-history",
      payload: { stationId: firstId },
      headers: { authorization: `Bearer ${token}` },
    });
    await app.inject({
      method: "POST",
      url: "/v1/me/listening-history",
      payload: { stationId: secondId },
      headers: { authorization: `Bearer ${token}` },
    });

    const list = await app.inject({
      method: "GET",
      url: "/v1/me/listening-history",
      headers: { authorization: `Bearer ${token}` },
    });
    const stationIds = (list.json().entries as Array<{ station: { id: number } }>).map((e) => e.station.id);
    expect(stationIds).toEqual([secondId, firstId]);

    await app.close();
  });

  it("preserves the history entry with a null station once the station is hard-deleted", async () => {
    const app = buildApp();
    const countryId = await getIsolatedCountryId(app);
    const adminToken = await createAdminToken(app, "hard-delete");
    const { token } = await createRegularAccount(app, "hard-delete");
    const stationId = await createStation(app, {
      countryId,
      adminToken,
      name: `History HardDelete ${Date.now()}`,
    });

    await app.inject({
      method: "POST",
      url: "/v1/me/listening-history",
      payload: { stationId },
      headers: { authorization: `Bearer ${token}` },
    });

    const del = await app.inject({
      method: "DELETE",
      url: `/v1/stations/${stationId}`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(del.statusCode).toBe(204);
    createdStationIds = createdStationIds.filter((id) => id !== stationId);

    const list = await app.inject({
      method: "GET",
      url: "/v1/me/listening-history",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(list.json().entries).toHaveLength(1);
    expect(list.json().entries[0].station).toBeNull();

    await app.close();
  });

  it("shows an inactive (deactivated) station in history, unlike favorites", async () => {
    const app = buildApp();
    const countryId = await getIsolatedCountryId(app);
    const adminToken = await createAdminToken(app, "inactive-visible");
    const { token } = await createRegularAccount(app, "inactive-visible");
    const stationId = await createStation(app, {
      countryId,
      adminToken,
      name: `History Inactive ${Date.now()}`,
    });

    await app.inject({
      method: "POST",
      url: "/v1/me/listening-history",
      payload: { stationId },
      headers: { authorization: `Bearer ${token}` },
    });

    await app.inject({
      method: "PATCH",
      url: `/v1/stations/${stationId}`,
      payload: { isActive: false },
      headers: { authorization: `Bearer ${adminToken}` },
    });

    const list = await app.inject({
      method: "GET",
      url: "/v1/me/listening-history",
      headers: { authorization: `Bearer ${token}` },
    });
    // Unlike Step 51's favorites list, a listening-history entry is a
    // historical record, not an actionable list - it still shows the
    // station even though it's now curated off.
    expect(list.json().entries).toHaveLength(1);
    expect(list.json().entries[0].station.id).toBe(stationId);
    expect(list.json().entries[0].station.isActive).toBe(false);

    await app.close();
  });

  it("clears the caller's own history without touching another account's", async () => {
    const app = buildApp();
    const countryId = await getIsolatedCountryId(app);
    const adminToken = await createAdminToken(app, "clear");
    const { token: tokenA } = await createRegularAccount(app, "clear-a");
    const { token: tokenB } = await createRegularAccount(app, "clear-b");
    const stationId = await createStation(app, { countryId, adminToken, name: `History Clear ${Date.now()}` });

    await app.inject({
      method: "POST",
      url: "/v1/me/listening-history",
      payload: { stationId },
      headers: { authorization: `Bearer ${tokenA}` },
    });
    await app.inject({
      method: "POST",
      url: "/v1/me/listening-history",
      payload: { stationId },
      headers: { authorization: `Bearer ${tokenB}` },
    });

    const clear = await app.inject({
      method: "DELETE",
      url: "/v1/me/listening-history",
      headers: { authorization: `Bearer ${tokenA}` },
    });
    expect(clear.statusCode).toBe(204);

    const listA = await app.inject({
      method: "GET",
      url: "/v1/me/listening-history",
      headers: { authorization: `Bearer ${tokenA}` },
    });
    expect(listA.json().entries).toHaveLength(0);

    const listB = await app.inject({
      method: "GET",
      url: "/v1/me/listening-history",
      headers: { authorization: `Bearer ${tokenB}` },
    });
    expect(listB.json().entries).toHaveLength(1);

    await app.close();
  });
});
