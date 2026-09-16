import { afterAll, afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { pool } from "../src/db/pool.js";
import { setUserRole } from "../src/repositories/usersRepository.js";

afterAll(async () => {
  await pool.end();
});

let createdUserIds: number[] = [];
let createdPlacementIds: number[] = [];
let nextCountryOffset = 0;

afterEach(async () => {
  if (createdPlacementIds.length > 0) {
    await pool.query("DELETE FROM ad_placements WHERE id = ANY($1)", [createdPlacementIds]);
    createdPlacementIds = [];
  }
  if (createdUserIds.length > 0) {
    await pool.query("DELETE FROM users WHERE id = ANY($1)", [createdUserIds]);
    createdUserIds = [];
  }
});

// Two distinct, isolated real countries per test that needs them (never
// countries[0], shared across every test file) - the same isolation
// discipline already established throughout this suite.
async function getIsolatedCountryIds(app: ReturnType<typeof buildApp>, count: number): Promise<number[]> {
  const response = await app.inject({ method: "GET", url: "/v1/countries" });
  const countries = response.json().countries as Array<{ id: number }>;
  const usableCountries = countries.slice(1);
  if (usableCountries.length < count) {
    throw new Error(`expected at least ${count + 1} seeded countries`);
  }
  const ids = Array.from(
    { length: count },
    (_, i) => usableCountries[(nextCountryOffset + i) % usableCountries.length].id,
  );
  nextCountryOffset += count;
  return ids;
}

async function createAdminToken(app: ReturnType<typeof buildApp>, label: string): Promise<string> {
  const email = `ads-admin-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
  const password = "ads-admin-password-123";
  const register = await app.inject({
    method: "POST",
    url: "/v1/users",
    payload: { email, password, displayName: "Ads Admin" },
  });
  const userId = register.json().user.id as number;
  createdUserIds.push(userId);
  await setUserRole(userId, "admin");
  const login = await app.inject({ method: "POST", url: "/v1/auth/login", payload: { email, password } });
  return login.json().token as string;
}

async function createRegularToken(app: ReturnType<typeof buildApp>, label: string): Promise<string> {
  const email = `ads-user-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
  const password = "ads-user-password-123";
  const register = await app.inject({
    method: "POST",
    url: "/v1/users",
    payload: { email, password, displayName: "Ads Regular User" },
  });
  createdUserIds.push(register.json().user.id as number);
  const login = await app.inject({ method: "POST", url: "/v1/auth/login", payload: { email, password } });
  return login.json().token as string;
}

function uniqueKey(label: string): string {
  return `placement-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

async function createPlacementViaApi(
  app: ReturnType<typeof buildApp>,
  adminToken: string,
  body: Record<string, unknown>,
): Promise<{ statusCode: number; json: () => { placement?: { id: number } } }> {
  const response = await app.inject({
    method: "POST",
    url: "/v1/admin/ads/placements",
    payload: body,
    headers: { authorization: `Bearer ${adminToken}` },
  });
  if (response.statusCode === 201) {
    createdPlacementIds.push(response.json().placement.id as number);
  }
  return response;
}

describe("Ad placements - admin CRUD (Step 56)", () => {
  it("requires authentication for every admin ads route, and admin role beyond that", async () => {
    const app = buildApp();
    const regularToken = await createRegularToken(app, "auth-gate");

    // Each request's payload (where relevant) is schema-valid on its own -
    // Fastify validates a route's body schema before its preHandler ever
    // runs, so a POST/PATCH sent with no body (missing required fields)
    // would 400 before authentication is even checked, the same reason
    // tests/pushTokens.test.ts's own identical auth-gate test always
    // sends a valid body too. This test is specifically isolating the
    // auth/role gate, not body validation.
    const routes: Array<{ method: "GET" | "POST" | "PATCH" | "DELETE"; url: string; payload?: unknown }> = [
      { method: "POST", url: "/v1/admin/ads/placements", payload: { placementKey: "x", adFormat: "banner" } },
      { method: "GET", url: "/v1/admin/ads/placements" },
      { method: "GET", url: "/v1/admin/ads/placements/1" },
      { method: "PATCH", url: "/v1/admin/ads/placements/1", payload: { adFormat: "banner" } },
      { method: "DELETE", url: "/v1/admin/ads/placements/1" },
    ];

    for (const route of routes) {
      const unauthenticated = await app.inject({
        method: route.method,
        url: route.url,
        payload: route.payload,
      });
      expect(unauthenticated.statusCode).toBe(401);

      const nonAdmin = await app.inject({
        method: route.method,
        url: route.url,
        payload: route.payload,
        headers: { authorization: `Bearer ${regularToken}` },
      });
      expect(nonAdmin.statusCode).toBe(403);
    }

    await app.close();
  });

  it("creates a global (countryId: null) placement, defaulting isActive to false", async () => {
    const app = buildApp();
    const adminToken = await createAdminToken(app, "create-global");

    const response = await createPlacementViaApi(app, adminToken, {
      placementKey: uniqueKey("global"),
      adFormat: "banner",
    });
    expect(response.statusCode).toBe(201);
    expect(response.json().placement).toMatchObject({
      countryId: null,
      adFormat: "banner",
      androidAdUnitId: null,
      iosAdUnitId: null,
      isActive: false,
    });

    await app.close();
  });

  it("creates a country-specific placement independently of a global one for the same key", async () => {
    const app = buildApp();
    const adminToken = await createAdminToken(app, "create-country");
    const [countryId] = await getIsolatedCountryIds(app, 1);
    const placementKey = uniqueKey("mixed");

    const global = await createPlacementViaApi(app, adminToken, { placementKey, adFormat: "banner" });
    expect(global.statusCode).toBe(201);

    const countrySpecific = await createPlacementViaApi(app, adminToken, {
      placementKey,
      countryId,
      adFormat: "interstitial",
    });
    expect(countrySpecific.statusCode).toBe(201);
    expect(countrySpecific.json().placement).toMatchObject({ countryId, adFormat: "interstitial" });

    await app.close();
  });

  it("rejects a second global placement for the same placementKey with 409", async () => {
    const app = buildApp();
    const adminToken = await createAdminToken(app, "dup-global");
    const placementKey = uniqueKey("dup-global");

    const first = await createPlacementViaApi(app, adminToken, { placementKey, adFormat: "banner" });
    expect(first.statusCode).toBe(201);

    const second = await createPlacementViaApi(app, adminToken, { placementKey, adFormat: "native" });
    expect(second.statusCode).toBe(409);

    await app.close();
  });

  it("rejects a second placement for the same placementKey and the same country with 409", async () => {
    const app = buildApp();
    const adminToken = await createAdminToken(app, "dup-country");
    const [countryId] = await getIsolatedCountryIds(app, 1);
    const placementKey = uniqueKey("dup-country");

    const first = await createPlacementViaApi(app, adminToken, { placementKey, countryId, adFormat: "banner" });
    expect(first.statusCode).toBe(201);

    const second = await createPlacementViaApi(app, adminToken, { placementKey, countryId, adFormat: "native" });
    expect(second.statusCode).toBe(409);

    await app.close();
  });

  it("rejects an unknown countryId with 400", async () => {
    const app = buildApp();
    const adminToken = await createAdminToken(app, "unknown-country");

    const response = await createPlacementViaApi(app, adminToken, {
      placementKey: uniqueKey("unknown-country"),
      countryId: 999999,
      adFormat: "banner",
    });
    expect(response.statusCode).toBe(400);

    await app.close();
  });

  it("rejects isActive: true with no ad unit id set, on both create and update", async () => {
    const app = buildApp();
    const adminToken = await createAdminToken(app, "requires-unit-id");

    const create = await createPlacementViaApi(app, adminToken, {
      placementKey: uniqueKey("requires-unit-id"),
      adFormat: "banner",
      isActive: true,
    });
    expect(create.statusCode).toBe(400);

    const staged = await createPlacementViaApi(app, adminToken, {
      placementKey: uniqueKey("requires-unit-id-2"),
      adFormat: "banner",
    });
    expect(staged.statusCode).toBe(201);
    const placementId = staged.json().placement!.id;

    const activateWithoutUnitId = await app.inject({
      method: "PATCH",
      url: `/v1/admin/ads/placements/${placementId}`,
      payload: { isActive: true },
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(activateWithoutUnitId.statusCode).toBe(400);

    await app.close();
  });

  it("activates successfully once at least one ad unit id is set", async () => {
    const app = buildApp();
    const adminToken = await createAdminToken(app, "activates");

    const response = await createPlacementViaApi(app, adminToken, {
      placementKey: uniqueKey("activates"),
      adFormat: "banner",
      androidAdUnitId: "ca-app-pub-0000000000000000/1111111111",
      isActive: true,
    });
    expect(response.statusCode).toBe(201);
    expect(response.json().placement).toMatchObject({ isActive: true });

    await app.close();
  });

  it("lists placements filtered by countryId and isActive", async () => {
    const app = buildApp();
    const adminToken = await createAdminToken(app, "list-filter");
    const [countryId] = await getIsolatedCountryIds(app, 1);
    const key = uniqueKey("list-filter");

    await createPlacementViaApi(app, adminToken, { placementKey: `${key}-a`, countryId, adFormat: "banner" });
    await createPlacementViaApi(app, adminToken, {
      placementKey: `${key}-b`,
      countryId,
      adFormat: "native",
      androidAdUnitId: "unit-1",
      isActive: true,
    });
    await createPlacementViaApi(app, adminToken, { placementKey: `${key}-c`, adFormat: "banner" });

    const byCountry = await app.inject({
      method: "GET",
      url: `/v1/admin/ads/placements?countryId=${countryId}`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    const byCountryKeys = byCountry
      .json()
      .placements.map((p: { placementKey: string }) => p.placementKey);
    expect(byCountryKeys).toEqual(expect.arrayContaining([`${key}-a`, `${key}-b`]));
    expect(byCountryKeys).not.toContain(`${key}-c`);

    const activeOnly = await app.inject({
      method: "GET",
      url: `/v1/admin/ads/placements?countryId=${countryId}&isActive=true`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    const activeKeys = activeOnly.json().placements.map((p: { placementKey: string }) => p.placementKey);
    expect(activeKeys).toEqual([`${key}-b`]);

    await app.close();
  });

  it("gets a single placement by id, 404 for an unknown one", async () => {
    const app = buildApp();
    const adminToken = await createAdminToken(app, "get-one");

    const created = await createPlacementViaApi(app, adminToken, {
      placementKey: uniqueKey("get-one"),
      adFormat: "rewarded",
    });
    const id = created.json().placement!.id;

    const found = await app.inject({
      method: "GET",
      url: `/v1/admin/ads/placements/${id}`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(found.statusCode).toBe(200);
    expect(found.json().placement.id).toBe(id);

    const notFound = await app.inject({
      method: "GET",
      url: "/v1/admin/ads/placements/999999999",
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(notFound.statusCode).toBe(404);

    await app.close();
  });

  it("updates a placement, requiring at least one field and 404ing for an unknown id", async () => {
    const app = buildApp();
    const adminToken = await createAdminToken(app, "update");

    const created = await createPlacementViaApi(app, adminToken, {
      placementKey: uniqueKey("update"),
      adFormat: "banner",
    });
    const id = created.json().placement!.id;

    const emptyBody = await app.inject({
      method: "PATCH",
      url: `/v1/admin/ads/placements/${id}`,
      payload: {},
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(emptyBody.statusCode).toBe(400);

    const update = await app.inject({
      method: "PATCH",
      url: `/v1/admin/ads/placements/${id}`,
      payload: { adFormat: "native" },
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(update.statusCode).toBe(200);
    expect(update.json().placement.adFormat).toBe("native");

    const unknownId = await app.inject({
      method: "PATCH",
      url: "/v1/admin/ads/placements/999999999",
      payload: { adFormat: "native" },
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(unknownId.statusCode).toBe(404);

    await app.close();
  });

  it("deletes a placement, 404 for an unknown id (not idempotent, unlike a user's own resource)", async () => {
    const app = buildApp();
    const adminToken = await createAdminToken(app, "delete");

    const created = await createPlacementViaApi(app, adminToken, {
      placementKey: uniqueKey("delete"),
      adFormat: "banner",
    });
    const id = created.json().placement!.id;

    const deleted = await app.inject({
      method: "DELETE",
      url: `/v1/admin/ads/placements/${id}`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(deleted.statusCode).toBe(204);

    const deleteAgain = await app.inject({
      method: "DELETE",
      url: `/v1/admin/ads/placements/${id}`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(deleteAgain.statusCode).toBe(404);

    await app.close();
  });
});

describe("GET /v1/ads/config (Step 56, public client-facing resolution)", () => {
  it("requires no authentication", async () => {
    const app = buildApp();
    const [countryId] = await getIsolatedCountryIds(app, 1);
    const response = await app.inject({ method: "GET", url: `/v1/ads/config?countryId=${countryId}` });
    expect(response.statusCode).toBe(200);
    await app.close();
  });

  it("returns the global default when no country-specific override exists", async () => {
    const app = buildApp();
    const adminToken = await createAdminToken(app, "config-global");
    const [countryId] = await getIsolatedCountryIds(app, 1);
    const placementKey = uniqueKey("config-global");

    await createPlacementViaApi(app, adminToken, {
      placementKey,
      adFormat: "banner",
      androidAdUnitId: "global-unit",
      isActive: true,
    });

    const response = await app.inject({ method: "GET", url: `/v1/ads/config?countryId=${countryId}` });
    const match = response
      .json()
      .placements.find((p: { placementKey: string }) => p.placementKey === placementKey);
    expect(match).toMatchObject({ countryId: null, androidAdUnitId: "global-unit" });

    await app.close();
  });

  it("prefers a country-specific override over the global default for the same key", async () => {
    const app = buildApp();
    const adminToken = await createAdminToken(app, "config-override");
    const [countryId] = await getIsolatedCountryIds(app, 1);
    const placementKey = uniqueKey("config-override");

    await createPlacementViaApi(app, adminToken, {
      placementKey,
      adFormat: "banner",
      androidAdUnitId: "global-unit",
      isActive: true,
    });
    await createPlacementViaApi(app, adminToken, {
      placementKey,
      countryId,
      adFormat: "banner",
      androidAdUnitId: "country-specific-unit",
      isActive: true,
    });

    const response = await app.inject({ method: "GET", url: `/v1/ads/config?countryId=${countryId}` });
    const matches = response
      .json()
      .placements.filter((p: { placementKey: string }) => p.placementKey === placementKey);
    // Exactly one row for this placementKey - the override, not both.
    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({ countryId, androidAdUnitId: "country-specific-unit" });

    await app.close();
  });

  it("never returns an inactive placement, even if it's the only one for that key", async () => {
    const app = buildApp();
    const adminToken = await createAdminToken(app, "config-inactive");
    const [countryId] = await getIsolatedCountryIds(app, 1);
    const placementKey = uniqueKey("config-inactive");

    await createPlacementViaApi(app, adminToken, { placementKey, adFormat: "banner" });

    const response = await app.inject({ method: "GET", url: `/v1/ads/config?countryId=${countryId}` });
    const match = response
      .json()
      .placements.find((p: { placementKey: string }) => p.placementKey === placementKey);
    expect(match).toBeUndefined();

    await app.close();
  });

  it("never returns a different country's override, falling back to the global default instead", async () => {
    const app = buildApp();
    const adminToken = await createAdminToken(app, "config-other-country");
    const [countryA, countryB] = await getIsolatedCountryIds(app, 2);
    const placementKey = uniqueKey("config-other-country");

    await createPlacementViaApi(app, adminToken, {
      placementKey,
      adFormat: "banner",
      androidAdUnitId: "global-unit",
      isActive: true,
    });
    await createPlacementViaApi(app, adminToken, {
      placementKey,
      countryId: countryA,
      adFormat: "banner",
      androidAdUnitId: "country-a-unit",
      isActive: true,
    });

    const response = await app.inject({ method: "GET", url: `/v1/ads/config?countryId=${countryB}` });
    const match = response
      .json()
      .placements.find((p: { placementKey: string }) => p.placementKey === placementKey);
    expect(match).toMatchObject({ countryId: null, androidAdUnitId: "global-unit" });

    await app.close();
  });

  it("rejects a request with no countryId with 400", async () => {
    const app = buildApp();
    const response = await app.inject({ method: "GET", url: "/v1/ads/config" });
    expect(response.statusCode).toBe(400);
    await app.close();
  });
});

describe("Ad placements - frequency cap (Step 57)", () => {
  it("rejects maxImpressionsPerPeriod set without frequencyCapPeriod, and vice versa, on create", async () => {
    const app = buildApp();
    const adminToken = await createAdminToken(app, "freq-cap-mismatch-create");

    const onlyMax = await createPlacementViaApi(app, adminToken, {
      placementKey: uniqueKey("freq-cap-only-max"),
      adFormat: "banner",
      maxImpressionsPerPeriod: 3,
    });
    expect(onlyMax.statusCode).toBe(400);

    const onlyPeriod = await createPlacementViaApi(app, adminToken, {
      placementKey: uniqueKey("freq-cap-only-period"),
      adFormat: "banner",
      frequencyCapPeriod: "day",
    });
    expect(onlyPeriod.statusCode).toBe(400);

    await app.close();
  });

  it("creates a placement with a real frequency cap when both fields are set together", async () => {
    const app = buildApp();
    const adminToken = await createAdminToken(app, "freq-cap-create");

    const response = await createPlacementViaApi(app, adminToken, {
      placementKey: uniqueKey("freq-cap-create"),
      adFormat: "banner",
      maxImpressionsPerPeriod: 3,
      frequencyCapPeriod: "day",
    });
    expect(response.statusCode).toBe(201);
    expect(response.json().placement).toMatchObject({
      maxImpressionsPerPeriod: 3,
      frequencyCapPeriod: "day",
    });

    await app.close();
  });

  it("rejects an update that would leave the pair mismatched, considering both existing and incoming values", async () => {
    const app = buildApp();
    const adminToken = await createAdminToken(app, "freq-cap-update-mismatch");

    const created = await createPlacementViaApi(app, adminToken, {
      placementKey: uniqueKey("freq-cap-update-mismatch"),
      adFormat: "banner",
      maxImpressionsPerPeriod: 5,
      frequencyCapPeriod: "session",
    });
    const id = created.json().placement!.id;

    // Trying to clear only one side of an already-set pair.
    const clearOnlyMax = await app.inject({
      method: "PATCH",
      url: `/v1/admin/ads/placements/${id}`,
      payload: { maxImpressionsPerPeriod: null },
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(clearOnlyMax.statusCode).toBe(400);

    // Clearing both together is fine.
    const clearBoth = await app.inject({
      method: "PATCH",
      url: `/v1/admin/ads/placements/${id}`,
      payload: { maxImpressionsPerPeriod: null, frequencyCapPeriod: null },
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(clearBoth.statusCode).toBe(200);
    expect(clearBoth.json().placement).toMatchObject({
      maxImpressionsPerPeriod: null,
      frequencyCapPeriod: null,
    });

    await app.close();
  });

  it("rejects a maxImpressionsPerPeriod beyond the documented bound", async () => {
    const app = buildApp();
    const adminToken = await createAdminToken(app, "freq-cap-bound");

    const response = await createPlacementViaApi(app, adminToken, {
      placementKey: uniqueKey("freq-cap-bound"),
      adFormat: "banner",
      maxImpressionsPerPeriod: 1001,
      frequencyCapPeriod: "day",
    });
    expect(response.statusCode).toBe(400);

    await app.close();
  });
});

describe("POST /v1/ads/events (Step 57, public first-party reporting)", () => {
  it("requires no authentication and records an impression", async () => {
    const app = buildApp();
    const adminToken = await createAdminToken(app, "event-record");
    const created = await createPlacementViaApi(app, adminToken, {
      placementKey: uniqueKey("event-record"),
      adFormat: "banner",
    });
    const placementId = created.json().placement!.id;

    const response = await app.inject({
      method: "POST",
      url: "/v1/ads/events",
      payload: { placementId, eventType: "impression" },
    });
    expect(response.statusCode).toBe(204);

    await app.close();
  });

  it("records a click, and accepts an optional countryId", async () => {
    const app = buildApp();
    const adminToken = await createAdminToken(app, "event-click");
    const [countryId] = await getIsolatedCountryIds(app, 1);
    const created = await createPlacementViaApi(app, adminToken, {
      placementKey: uniqueKey("event-click"),
      adFormat: "banner",
    });
    const placementId = created.json().placement!.id;

    const response = await app.inject({
      method: "POST",
      url: "/v1/ads/events",
      payload: { placementId, eventType: "click", countryId },
    });
    expect(response.statusCode).toBe(204);

    await app.close();
  });

  it("rejects an unknown placementId with 400", async () => {
    const app = buildApp();
    const response = await app.inject({
      method: "POST",
      url: "/v1/ads/events",
      payload: { placementId: 999999999, eventType: "impression" },
    });
    expect(response.statusCode).toBe(400);
    await app.close();
  });

  it("rejects an invalid eventType with 400", async () => {
    const app = buildApp();
    const adminToken = await createAdminToken(app, "event-invalid-type");
    const created = await createPlacementViaApi(app, adminToken, {
      placementKey: uniqueKey("event-invalid-type"),
      adFormat: "banner",
    });
    const placementId = created.json().placement!.id;

    const response = await app.inject({
      method: "POST",
      url: "/v1/ads/events",
      payload: { placementId, eventType: "view" },
    });
    expect(response.statusCode).toBe(400);
    await app.close();
  });

  it("rate-limits to 60/min", async () => {
    const app = buildApp();
    const adminToken = await createAdminToken(app, "event-rate-limit");
    const created = await createPlacementViaApi(app, adminToken, {
      placementKey: uniqueKey("event-rate-limit"),
      adFormat: "banner",
    });
    const placementId = created.json().placement!.id;

    const responses = [];
    for (let i = 0; i < 61; i++) {
      responses.push(
        await app.inject({
          method: "POST",
          url: "/v1/ads/events",
          payload: { placementId, eventType: "impression" },
        }),
      );
    }
    const statusCodes = responses.map((r) => r.statusCode);
    expect(statusCodes.slice(0, 60).every((code) => code === 204)).toBe(true);
    expect(statusCodes[60]).toBe(429);

    await app.close();
  });
});

describe("GET /v1/admin/ads/reports (Step 57)", () => {
  it("requires authentication and admin role", async () => {
    const app = buildApp();
    const regularToken = await createRegularToken(app, "report-auth");

    const unauthenticated = await app.inject({ method: "GET", url: "/v1/admin/ads/reports" });
    expect(unauthenticated.statusCode).toBe(401);

    const nonAdmin = await app.inject({
      method: "GET",
      url: "/v1/admin/ads/reports",
      headers: { authorization: `Bearer ${regularToken}` },
    });
    expect(nonAdmin.statusCode).toBe(403);

    await app.close();
  });

  it("reports real recorded counts, and a real zero for a placement with no events", async () => {
    const app = buildApp();
    const adminToken = await createAdminToken(app, "report-counts");
    const withEvents = await createPlacementViaApi(app, adminToken, {
      placementKey: uniqueKey("report-with-events"),
      adFormat: "banner",
    });
    const withEventsId = withEvents.json().placement!.id;
    const withoutEvents = await createPlacementViaApi(app, adminToken, {
      placementKey: uniqueKey("report-without-events"),
      adFormat: "banner",
    });
    const withoutEventsId = withoutEvents.json().placement!.id;

    await app.inject({
      method: "POST",
      url: "/v1/ads/events",
      payload: { placementId: withEventsId, eventType: "impression" },
    });
    await app.inject({
      method: "POST",
      url: "/v1/ads/events",
      payload: { placementId: withEventsId, eventType: "impression" },
    });
    await app.inject({
      method: "POST",
      url: "/v1/ads/events",
      payload: { placementId: withEventsId, eventType: "click" },
    });

    const response = await app.inject({
      method: "GET",
      url: "/v1/admin/ads/reports",
      headers: { authorization: `Bearer ${adminToken}` },
    });
    const report = response.json().report as Array<{
      placementId: number;
      impressions: number;
      clicks: number;
    }>;
    const withEventsRow = report.find((r) => r.placementId === withEventsId);
    const withoutEventsRow = report.find((r) => r.placementId === withoutEventsId);
    expect(withEventsRow).toMatchObject({ impressions: 2, clicks: 1 });
    // The zero-event placement still appears, with real 0s, not omitted.
    expect(withoutEventsRow).toMatchObject({ impressions: 0, clicks: 0 });

    await app.close();
  });

  it("filters by countryId without ever hiding a placement that simply has no matching events", async () => {
    const app = buildApp();
    const adminToken = await createAdminToken(app, "report-country-filter");
    const [countryA, countryB] = await getIsolatedCountryIds(app, 2);
    const created = await createPlacementViaApi(app, adminToken, {
      placementKey: uniqueKey("report-country-filter"),
      adFormat: "banner",
    });
    const placementId = created.json().placement!.id;

    await app.inject({
      method: "POST",
      url: "/v1/ads/events",
      payload: { placementId, eventType: "impression", countryId: countryA },
    });

    const filteredToA = await app.inject({
      method: "GET",
      url: `/v1/admin/ads/reports?countryId=${countryA}`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    const rowInA = filteredToA
      .json()
      .report.find((r: { placementId: number }) => r.placementId === placementId);
    expect(rowInA).toMatchObject({ impressions: 1 });

    // The placement still appears when filtered to a country it has no
    // events for - with a real 0, not hidden entirely.
    const filteredToB = await app.inject({
      method: "GET",
      url: `/v1/admin/ads/reports?countryId=${countryB}`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    const rowInB = filteredToB
      .json()
      .report.find((r: { placementId: number }) => r.placementId === placementId);
    expect(rowInB).toMatchObject({ impressions: 0 });

    await app.close();
  });

  it("filters by date range", async () => {
    const app = buildApp();
    const adminToken = await createAdminToken(app, "report-date-filter");
    const created = await createPlacementViaApi(app, adminToken, {
      placementKey: uniqueKey("report-date-filter"),
      adFormat: "banner",
    });
    const placementId = created.json().placement!.id;

    await app.inject({
      method: "POST",
      url: "/v1/ads/events",
      payload: { placementId, eventType: "impression" },
    });

    const futureWindow = await app.inject({
      method: "GET",
      url: `/v1/admin/ads/reports?startsAfter=${encodeURIComponent(new Date(Date.now() + 60_000).toISOString())}`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    const rowInFuture = futureWindow
      .json()
      .report.find((r: { placementId: number }) => r.placementId === placementId);
    expect(rowInFuture).toMatchObject({ impressions: 0 });

    const pastWindow = await app.inject({
      method: "GET",
      url: `/v1/admin/ads/reports?startsAfter=${encodeURIComponent(new Date(Date.now() - 60_000).toISOString())}`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    const rowInPast = pastWindow
      .json()
      .report.find((r: { placementId: number }) => r.placementId === placementId);
    expect(rowInPast).toMatchObject({ impressions: 1 });

    await app.close();
  });
});
