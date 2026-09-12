import { afterAll, afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { pool } from "../src/db/pool.js";
import { setUserRole } from "../src/repositories/usersRepository.js";

afterAll(async () => {
  await pool.end();
});

// Neither GET /v1/stations nor GET /v1/events has a filter this file's own
// favorite relationships could be scoped through - a favorite is keyed on
// (userId, stationId/eventId), invisible to any query against the
// stations/events tables alone. The correctness guarantee here is
// therefore entirely the afterEach cleanup below (every station/event/user
// this file creates, and by FK cascade every favorite row pointing at
// them), the same discipline already applied throughout this suite for
// every table with no q=-style marker to filter by.
let createdStationIds: number[] = [];
let createdEventIds: number[] = [];
let createdUserIds: number[] = [];
let nextCountryOffset = 0;

afterEach(async () => {
  if (createdStationIds.length > 0) {
    await pool.query("DELETE FROM radio_stations WHERE id = ANY($1)", [createdStationIds]);
    createdStationIds = [];
  }
  if (createdEventIds.length > 0) {
    await pool.query("DELETE FROM events WHERE id = ANY($1)", [createdEventIds]);
    createdEventIds = [];
  }
  if (createdUserIds.length > 0) {
    await pool.query("DELETE FROM users WHERE id = ANY($1)", [createdUserIds]);
    createdUserIds = [];
  }
});

async function getIsolatedCountryId(app: ReturnType<typeof buildApp>): Promise<number> {
  const response = await app.inject({ method: "GET", url: "/v1/countries" });
  const countries = response.json().countries as Array<{ id: number }>;
  const usableCountries = countries.slice(1); // never countries[0] - shared across every test file
  if (usableCountries.length === 0) throw new Error("expected at least 2 seeded countries");
  const country = usableCountries[nextCountryOffset % usableCountries.length];
  nextCountryOffset++;
  return country.id;
}

async function createAdminToken(app: ReturnType<typeof buildApp>, label: string): Promise<string> {
  const email = `favorites-admin-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
  const password = "favorites-admin-password-123";
  const register = await app.inject({
    method: "POST",
    url: "/v1/users",
    payload: { email, password, displayName: "Favorites Admin" },
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
  const email = `favorites-user-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
  const password = "favorites-user-password-123";
  const register = await app.inject({
    method: "POST",
    url: "/v1/users",
    payload: { email, password, displayName: "Favorites Regular User" },
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

function futureIso(hoursFromNow: number): string {
  return new Date(Date.now() + hoursFromNow * 60 * 60 * 1000).toISOString();
}

async function createEventViaApi(
  app: ReturnType<typeof buildApp>,
  options: { countryId: number; token: string; title: string },
): Promise<number> {
  const response = await app.inject({
    method: "POST",
    url: "/v1/events",
    payload: { countryId: options.countryId, title: options.title, startsAt: futureIso(24) },
    headers: { authorization: `Bearer ${options.token}` },
  });
  expect(response.statusCode).toBe(201);
  const eventId = response.json().event.id as number;
  createdEventIds.push(eventId);
  return eventId;
}

describe("Favorites - stations", () => {
  it("requires authentication for every favorites route", async () => {
    const app = buildApp();
    const list = await app.inject({ method: "GET", url: "/v1/me/favorites/stations" });
    expect(list.statusCode).toBe(401);
    const put = await app.inject({ method: "PUT", url: "/v1/me/favorites/stations/1" });
    expect(put.statusCode).toBe(401);
    const del = await app.inject({ method: "DELETE", url: "/v1/me/favorites/stations/1" });
    expect(del.statusCode).toBe(401);
    await app.close();
  });

  it("favorites a station and lists it back, hydrated", async () => {
    const app = buildApp();
    const countryId = await getIsolatedCountryId(app);
    const adminToken = await createAdminToken(app, "favorite-list");
    const { token } = await createRegularAccount(app, "favorite-list");
    const marker = `Favorite Station ${Date.now()}${Math.random().toString(36).slice(2)}`;
    const stationId = await createStation(app, { countryId, adminToken, name: marker });

    const put = await app.inject({
      method: "PUT",
      url: `/v1/me/favorites/stations/${stationId}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(put.statusCode).toBe(204);

    const list = await app.inject({
      method: "GET",
      url: "/v1/me/favorites/stations",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(list.statusCode).toBe(200);
    const body = list.json();
    expect(body.favorites).toHaveLength(1);
    expect(body.favorites[0].station.id).toBe(stationId);
    expect(body.favorites[0].station.name).toBe(marker);
    expect(typeof body.favorites[0].favoritedAt).toBe("string");
    expect(body.pagination.total).toBe(1);

    await app.close();
  });

  it("favoriting is idempotent - favoriting twice does not error or duplicate", async () => {
    const app = buildApp();
    const countryId = await getIsolatedCountryId(app);
    const adminToken = await createAdminToken(app, "idempotent");
    const { token } = await createRegularAccount(app, "idempotent");
    const stationId = await createStation(app, {
      countryId,
      adminToken,
      name: `Favorite Idempotent ${Date.now()}`,
    });

    const first = await app.inject({
      method: "PUT",
      url: `/v1/me/favorites/stations/${stationId}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(first.statusCode).toBe(204);
    const second = await app.inject({
      method: "PUT",
      url: `/v1/me/favorites/stations/${stationId}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(second.statusCode).toBe(204);

    const list = await app.inject({
      method: "GET",
      url: "/v1/me/favorites/stations",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(list.json().favorites).toHaveLength(1);

    await app.close();
  });

  it("returns 404 favoriting an unknown or inactive station", async () => {
    const app = buildApp();
    const countryId = await getIsolatedCountryId(app);
    const adminToken = await createAdminToken(app, "inactive");
    const { token } = await createRegularAccount(app, "inactive");
    const stationId = await createStation(app, {
      countryId,
      adminToken,
      name: `Favorite Inactive ${Date.now()}`,
    });

    const unknown = await app.inject({
      method: "PUT",
      url: "/v1/me/favorites/stations/99999999",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(unknown.statusCode).toBe(404);

    const deactivate = await app.inject({
      method: "PATCH",
      url: `/v1/stations/${stationId}`,
      payload: { isActive: false },
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(deactivate.statusCode).toBe(200);

    const favoriteInactive = await app.inject({
      method: "PUT",
      url: `/v1/me/favorites/stations/${stationId}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(favoriteInactive.statusCode).toBe(404);

    await app.close();
  });

  it("un-favoriting removes it from the list, and is idempotent", async () => {
    const app = buildApp();
    const countryId = await getIsolatedCountryId(app);
    const adminToken = await createAdminToken(app, "unfavorite");
    const { token } = await createRegularAccount(app, "unfavorite");
    const stationId = await createStation(app, {
      countryId,
      adminToken,
      name: `Favorite Remove ${Date.now()}`,
    });

    await app.inject({
      method: "PUT",
      url: `/v1/me/favorites/stations/${stationId}`,
      headers: { authorization: `Bearer ${token}` },
    });

    const del = await app.inject({
      method: "DELETE",
      url: `/v1/me/favorites/stations/${stationId}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(del.statusCode).toBe(204);

    // Idempotent: removing an already-absent favorite still succeeds.
    const delAgain = await app.inject({
      method: "DELETE",
      url: `/v1/me/favorites/stations/${stationId}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(delAgain.statusCode).toBe(204);

    const list = await app.inject({
      method: "GET",
      url: "/v1/me/favorites/stations",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(list.json().favorites).toHaveLength(0);
    expect(list.json().pagination.total).toBe(0);

    await app.close();
  });

  it("a station later deactivated drops out of the favorites list without deleting the favorite", async () => {
    const app = buildApp();
    const countryId = await getIsolatedCountryId(app);
    const adminToken = await createAdminToken(app, "soft-state");
    const { token, userId } = await createRegularAccount(app, "soft-state");
    const stationId = await createStation(app, {
      countryId,
      adminToken,
      name: `Favorite SoftState ${Date.now()}`,
    });

    await app.inject({
      method: "PUT",
      url: `/v1/me/favorites/stations/${stationId}`,
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
      url: "/v1/me/favorites/stations",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(list.json().favorites).toHaveLength(0);

    // The favorite row itself is still there, soft-state (never silently
    // deleted) - checked directly against the database, not just the API's
    // own filtered view of it.
    const row = await pool.query(
      "SELECT 1 FROM user_favorite_stations WHERE user_id = $1 AND station_id = $2",
      [userId, stationId],
    );
    expect(row.rowCount).toBe(1);

    // Reactivating brings it back into view with no re-favoriting needed.
    await app.inject({
      method: "PATCH",
      url: `/v1/stations/${stationId}`,
      payload: { isActive: true },
      headers: { authorization: `Bearer ${adminToken}` },
    });
    const listAfterReactivate = await app.inject({
      method: "GET",
      url: "/v1/me/favorites/stations",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(listAfterReactivate.json().favorites).toHaveLength(1);

    await app.close();
  });

  it("deleting a user cascades away their station favorites", async () => {
    const app = buildApp();
    const countryId = await getIsolatedCountryId(app);
    const adminToken = await createAdminToken(app, "cascade");
    const { token, userId } = await createRegularAccount(app, "cascade");
    const stationId = await createStation(app, {
      countryId,
      adminToken,
      name: `Favorite Cascade ${Date.now()}`,
    });

    await app.inject({
      method: "PUT",
      url: `/v1/me/favorites/stations/${stationId}`,
      headers: { authorization: `Bearer ${token}` },
    });

    await pool.query("DELETE FROM users WHERE id = $1", [userId]);
    createdUserIds = createdUserIds.filter((id) => id !== userId);

    const row = await pool.query("SELECT 1 FROM user_favorite_stations WHERE user_id = $1", [userId]);
    expect(row.rowCount).toBe(0);

    await app.close();
  });

  it("one account's favorite is invisible to another account", async () => {
    const app = buildApp();
    const countryId = await getIsolatedCountryId(app);
    const adminToken = await createAdminToken(app, "isolation");
    const { token: tokenA } = await createRegularAccount(app, "isolation-a");
    const { token: tokenB } = await createRegularAccount(app, "isolation-b");
    const stationId = await createStation(app, {
      countryId,
      adminToken,
      name: `Favorite Isolation ${Date.now()}`,
    });

    await app.inject({
      method: "PUT",
      url: `/v1/me/favorites/stations/${stationId}`,
      headers: { authorization: `Bearer ${tokenA}` },
    });

    const listB = await app.inject({
      method: "GET",
      url: "/v1/me/favorites/stations",
      headers: { authorization: `Bearer ${tokenB}` },
    });
    expect(listB.json().favorites).toHaveLength(0);

    await app.close();
  });
});

describe("Favorites - events", () => {
  it("favorites an event and lists it back, hydrated", async () => {
    const app = buildApp();
    const countryId = await getIsolatedCountryId(app);
    const adminToken = await createAdminToken(app, "event-favorite");
    const { token } = await createRegularAccount(app, "event-favorite");
    const marker = `Favorite Event ${Date.now()}${Math.random().toString(36).slice(2)}`;
    // Admin submissions auto-approve (Step 24), so this is immediately
    // favoritable without a separate moderation step.
    const eventId = await createEventViaApi(app, { countryId, token: adminToken, title: marker });

    const put = await app.inject({
      method: "PUT",
      url: `/v1/me/favorites/events/${eventId}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(put.statusCode).toBe(204);

    const list = await app.inject({
      method: "GET",
      url: "/v1/me/favorites/events",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(list.statusCode).toBe(200);
    const body = list.json();
    expect(body.favorites).toHaveLength(1);
    expect(body.favorites[0].event.id).toBe(eventId);
    expect(body.favorites[0].event.title).toBe(marker);
    expect(typeof body.favorites[0].favoritedAt).toBe("string");

    await app.close();
  });

  it("returns 404 favoriting an unknown or still-pending event", async () => {
    const app = buildApp();
    const countryId = await getIsolatedCountryId(app);
    const { token: submitterToken } = await createRegularAccount(app, "pending-submitter");
    const { token } = await createRegularAccount(app, "pending-favoriter");
    // A regular user's own submission starts pending (Step 24) - not yet
    // publicly visible, so not yet favoritable either.
    const eventId = await createEventViaApi(app, {
      countryId,
      token: submitterToken,
      title: `Favorite Pending ${Date.now()}`,
    });

    const favoritePending = await app.inject({
      method: "PUT",
      url: `/v1/me/favorites/events/${eventId}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(favoritePending.statusCode).toBe(404);

    const unknown = await app.inject({
      method: "PUT",
      url: "/v1/me/favorites/events/99999999",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(unknown.statusCode).toBe(404);

    await app.close();
  });

  it("an event later rejected drops out of the favorites list without deleting the favorite", async () => {
    const app = buildApp();
    const countryId = await getIsolatedCountryId(app);
    const adminToken = await createAdminToken(app, "event-soft-state");
    const { token, userId } = await createRegularAccount(app, "event-soft-state");
    const eventId = await createEventViaApi(app, {
      countryId,
      token: adminToken,
      title: `Favorite Event SoftState ${Date.now()}`,
    });

    await app.inject({
      method: "PUT",
      url: `/v1/me/favorites/events/${eventId}`,
      headers: { authorization: `Bearer ${token}` },
    });

    await app.inject({
      method: "PATCH",
      url: `/v1/events/${eventId}`,
      payload: { status: "rejected" },
      headers: { authorization: `Bearer ${adminToken}` },
    });

    const list = await app.inject({
      method: "GET",
      url: "/v1/me/favorites/events",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(list.json().favorites).toHaveLength(0);

    const row = await pool.query("SELECT 1 FROM user_favorite_events WHERE user_id = $1 AND event_id = $2", [
      userId,
      eventId,
    ]);
    expect(row.rowCount).toBe(1);

    await app.close();
  });

  it("un-favoriting an event is idempotent", async () => {
    const app = buildApp();
    const countryId = await getIsolatedCountryId(app);
    const adminToken = await createAdminToken(app, "event-unfavorite");
    const { token } = await createRegularAccount(app, "event-unfavorite");
    const eventId = await createEventViaApi(app, {
      countryId,
      token: adminToken,
      title: `Favorite Event Remove ${Date.now()}`,
    });

    await app.inject({
      method: "PUT",
      url: `/v1/me/favorites/events/${eventId}`,
      headers: { authorization: `Bearer ${token}` },
    });

    const del = await app.inject({
      method: "DELETE",
      url: `/v1/me/favorites/events/${eventId}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(del.statusCode).toBe(204);
    const delAgain = await app.inject({
      method: "DELETE",
      url: `/v1/me/favorites/events/${eventId}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(delAgain.statusCode).toBe(204);

    await app.close();
  });
});
