import { afterAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { pool } from "../src/db/pool.js";
import { setUserRole } from "../src/repositories/usersRepository.js";

async function getRealCountryId(app: ReturnType<typeof buildApp>): Promise<number> {
  const response = await app.inject({ method: "GET", url: "/v1/countries" });
  const countries = response.json().countries as Array<{ id: number }>;
  const country = countries[0];
  if (!country) throw new Error("expected at least one seeded country");
  return country.id;
}

async function createAdminToken(app: ReturnType<typeof buildApp>, label: string): Promise<string> {
  const email = `stations-admin-${label}-${Date.now()}@example.com`;
  const password = "stations-admin-password-123";
  const register = await app.inject({
    method: "POST",
    url: "/v1/users",
    payload: { email, password, displayName: "Stations Admin" },
  });
  const userId = register.json().user.id as number;
  await setUserRole(userId, "admin");

  const login = await app.inject({ method: "POST", url: "/v1/auth/login", payload: { email, password } });
  return login.json().token as string;
}

async function createRegularToken(app: ReturnType<typeof buildApp>, label: string): Promise<string> {
  const email = `stations-user-${label}-${Date.now()}@example.com`;
  const password = "stations-user-password-123";
  await app.inject({
    method: "POST",
    url: "/v1/users",
    payload: { email, password, displayName: "Stations Regular User" },
  });
  const login = await app.inject({ method: "POST", url: "/v1/auth/login", payload: { email, password } });
  return login.json().token as string;
}

function uniqueStreamUrl(label: string): string {
  return `https://stream.example.com/${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

describe("radio stations", () => {
  afterAll(async () => {
    await pool.end();
  });

  it("rejects station creation with no token, and with a non-admin token", async () => {
    const app = buildApp();
    const countryId = await getRealCountryId(app);
    const payload = { countryId, name: "Auth Test Station", streamUrl: uniqueStreamUrl("auth") };

    const noToken = await app.inject({ method: "POST", url: "/v1/stations", payload });
    expect(noToken.statusCode).toBe(401);

    const regularToken = await createRegularToken(app, "authcheck");
    const nonAdmin = await app.inject({
      method: "POST",
      url: "/v1/stations",
      payload,
      headers: { authorization: `Bearer ${regularToken}` },
    });
    expect(nonAdmin.statusCode).toBe(403);

    await app.close();
  });

  it("lets an admin create, read, update, and delete a station end to end", async () => {
    const app = buildApp();
    const countryId = await getRealCountryId(app);
    const adminToken = await createAdminToken(app, "crud");
    const streamUrl = uniqueStreamUrl("crud");

    const create = await app.inject({
      method: "POST",
      url: "/v1/stations",
      payload: { countryId, name: "CRUD Test Station", streamUrl, description: "A test station" },
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(create.statusCode).toBe(201);
    const created = create.json().station;
    expect(created).toMatchObject({
      countryId,
      name: "CRUD Test Station",
      streamUrl,
      description: "A test station",
      websiteUrl: null,
      isActive: true,
    });
    const stationId = created.id as number;

    // Publicly readable, no auth required.
    const getPublic = await app.inject({ method: "GET", url: `/v1/stations/${stationId}` });
    expect(getPublic.statusCode).toBe(200);
    expect(getPublic.json().station.name).toBe("CRUD Test Station");

    // Shows up in the country's public listing.
    const list = await app.inject({ method: "GET", url: `/v1/stations?countryId=${countryId}` });
    expect(list.statusCode).toBe(200);
    const listedIds = (list.json().stations as Array<{ id: number }>).map((s) => s.id);
    expect(listedIds).toContain(stationId);

    // Admin updates the name.
    const update = await app.inject({
      method: "PATCH",
      url: `/v1/stations/${stationId}`,
      payload: { name: "Renamed Test Station" },
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(update.statusCode).toBe(200);
    expect(update.json().station.name).toBe("Renamed Test Station");
    // Untouched fields survive a partial update.
    expect(update.json().station.streamUrl).toBe(streamUrl);

    // Deactivating pulls it from the public listing and detail view...
    const deactivate = await app.inject({
      method: "PATCH",
      url: `/v1/stations/${stationId}`,
      payload: { isActive: false },
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(deactivate.statusCode).toBe(200);
    expect(deactivate.json().station.isActive).toBe(false);

    const getAfterDeactivate = await app.inject({ method: "GET", url: `/v1/stations/${stationId}` });
    expect(getAfterDeactivate.statusCode).toBe(404);

    const listAfterDeactivate = await app.inject({
      method: "GET",
      url: `/v1/stations?countryId=${countryId}`,
    });
    const idsAfterDeactivate = (listAfterDeactivate.json().stations as Array<{ id: number }>).map(
      (s) => s.id,
    );
    expect(idsAfterDeactivate).not.toContain(stationId);

    // ...but an admin can still find and hard-delete it directly by id.
    const remove = await app.inject({
      method: "DELETE",
      url: `/v1/stations/${stationId}`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(remove.statusCode).toBe(204);

    const removeAgain = await app.inject({
      method: "DELETE",
      url: `/v1/stations/${stationId}`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(removeAgain.statusCode).toBe(404);

    await app.close();
  });

  it("silently strips an unknown field rather than rejecting the request", async () => {
    const app = buildApp();
    const countryId = await getRealCountryId(app);
    const adminToken = await createAdminToken(app, "strip");

    const create = await app.inject({
      method: "POST",
      url: "/v1/stations",
      payload: {
        countryId,
        name: "Strip Test Station",
        streamUrl: uniqueStreamUrl("strip"),
        genre: "reggae",
      },
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(create.statusCode).toBe(201);
    expect(create.json().station).not.toHaveProperty("genre");

    await app.close();
  });

  it("rejects a duplicate stream URL with 409, and an unknown countryId with 400", async () => {
    const app = buildApp();
    const countryId = await getRealCountryId(app);
    const adminToken = await createAdminToken(app, "dupe");
    const streamUrl = uniqueStreamUrl("dupe");

    const first = await app.inject({
      method: "POST",
      url: "/v1/stations",
      payload: { countryId, name: "First Station", streamUrl },
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(first.statusCode).toBe(201);

    const duplicate = await app.inject({
      method: "POST",
      url: "/v1/stations",
      payload: { countryId, name: "Second Station", streamUrl },
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(duplicate.statusCode).toBe(409);

    const unknownCountry = await app.inject({
      method: "POST",
      url: "/v1/stations",
      payload: { countryId: 999_999, name: "Nowhere Station", streamUrl: uniqueStreamUrl("nowhere") },
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(unknownCountry.statusCode).toBe(400);

    await app.close();
  });

  it("returns 404 for a nonexistent station id on get, update, and delete", async () => {
    const app = buildApp();
    const adminToken = await createAdminToken(app, "notfound");

    const get = await app.inject({ method: "GET", url: "/v1/stations/999999999" });
    expect(get.statusCode).toBe(404);

    const update = await app.inject({
      method: "PATCH",
      url: "/v1/stations/999999999",
      payload: { name: "Ghost Station" },
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(update.statusCode).toBe(404);

    const remove = await app.inject({
      method: "DELETE",
      url: "/v1/stations/999999999",
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(remove.statusCode).toBe(404);

    await app.close();
  });

  it("rejects update and delete from a non-admin token", async () => {
    const app = buildApp();
    const countryId = await getRealCountryId(app);
    const adminToken = await createAdminToken(app, "gate-setup");
    const regularToken = await createRegularToken(app, "gate");

    const create = await app.inject({
      method: "POST",
      url: "/v1/stations",
      payload: { countryId, name: "Gate Test Station", streamUrl: uniqueStreamUrl("gate") },
      headers: { authorization: `Bearer ${adminToken}` },
    });
    const stationId = create.json().station.id as number;

    const update = await app.inject({
      method: "PATCH",
      url: `/v1/stations/${stationId}`,
      payload: { name: "Hijacked Name" },
      headers: { authorization: `Bearer ${regularToken}` },
    });
    expect(update.statusCode).toBe(403);

    const remove = await app.inject({
      method: "DELETE",
      url: `/v1/stations/${stationId}`,
      headers: { authorization: `Bearer ${regularToken}` },
    });
    expect(remove.statusCode).toBe(403);

    await app.close();
  });
});
