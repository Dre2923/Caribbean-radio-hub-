import { afterAll, afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { pool } from "../src/db/pool.js";
import { setUserRole } from "../src/repositories/usersRepository.js";

afterAll(async () => {
  await pool.end();
});

// GET /v1/events has no q=/search filter (unlike stations - see Step
// 18/20's fixes), so a test can't narrow the public listing down to just
// its own rows the way a search-filtered query could. Same two-layer
// protection as tests/stationRanking.test.ts: isolated countries (never
// countries[0], which every other test file's getRealCountryId uses and
// has accumulated well over a thousand stations/events across this
// build's many local runs) plus afterEach hard-deletion of every event a
// test itself creates.
//
// Unlike stationRanking.test.ts, this uses only two *fixed* isolated
// country indices (1 and 2) shared across every test in this file, rather
// than a fresh one per test - there are only 13 seeded launch countries
// (see the .env.example seed data), which isn't enough for one-per-test
// across this file's ~20 tests. Reusing them is safe specifically because
// afterEach unconditionally clears every event this file creates before
// the next test runs, so each test still starts from a genuinely empty
// slate in both countries - the isolation property that actually matters
// (no cross-test interference) holds either way.
let createdEventIds: number[] = [];

afterEach(async () => {
  if (createdEventIds.length > 0) {
    await pool.query("DELETE FROM events WHERE id = ANY($1)", [createdEventIds]);
    createdEventIds = [];
  }
});

async function getIsolatedCountryIds(app: ReturnType<typeof buildApp>): Promise<[number, number]> {
  const response = await app.inject({ method: "GET", url: "/v1/countries" });
  const countries = response.json().countries as Array<{ id: number }>;
  const primary = countries[1];
  const secondary = countries[2];
  if (!primary || !secondary) throw new Error("expected at least 3 seeded countries");
  return [primary.id, secondary.id];
}

async function getIsolatedCountryId(app: ReturnType<typeof buildApp>): Promise<number> {
  const [primary] = await getIsolatedCountryIds(app);
  return primary;
}

async function createAdminAccount(
  app: ReturnType<typeof buildApp>,
  label: string,
): Promise<{ token: string; userId: number }> {
  const email = `events-admin-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
  const password = "events-admin-password-123";
  const register = await app.inject({
    method: "POST",
    url: "/v1/users",
    payload: { email, password, displayName: "Events Admin" },
  });
  const userId = register.json().user.id as number;
  await setUserRole(userId, "admin");

  const login = await app.inject({ method: "POST", url: "/v1/auth/login", payload: { email, password } });
  return { token: login.json().token as string, userId };
}

async function createAdminToken(app: ReturnType<typeof buildApp>, label: string): Promise<string> {
  return (await createAdminAccount(app, label)).token;
}

async function createRegularAccount(
  app: ReturnType<typeof buildApp>,
  label: string,
): Promise<{ token: string; userId: number }> {
  const email = `events-user-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
  const password = "events-user-password-123";
  const register = await app.inject({
    method: "POST",
    url: "/v1/users",
    payload: { email, password, displayName: "Events Regular User" },
  });
  const userId = register.json().user.id as number;
  const login = await app.inject({ method: "POST", url: "/v1/auth/login", payload: { email, password } });
  return { token: login.json().token as string, userId };
}

async function createRegularToken(app: ReturnType<typeof buildApp>, label: string): Promise<string> {
  return (await createRegularAccount(app, label)).token;
}

function futureIso(hoursFromNow: number): string {
  return new Date(Date.now() + hoursFromNow * 60 * 60 * 1000).toISOString();
}

interface CreateEventOptions {
  countryId: number;
  token: string;
  title: string;
  description?: string;
  venue?: string;
  startsAt?: string;
  endsAt?: string;
  imageUrl?: string;
  ticketUrl?: string;
  categoryIds?: number[];
}

async function createEventViaApi(
  app: ReturnType<typeof buildApp>,
  options: CreateEventOptions,
) {
  const response = await app.inject({
    method: "POST",
    url: "/v1/events",
    payload: {
      countryId: options.countryId,
      title: options.title,
      description: options.description,
      venue: options.venue,
      startsAt: options.startsAt ?? futureIso(24),
      endsAt: options.endsAt,
      imageUrl: options.imageUrl,
      ticketUrl: options.ticketUrl,
      categoryIds: options.categoryIds,
    },
    headers: { authorization: `Bearer ${options.token}` },
  });
  if (response.statusCode === 201) {
    createdEventIds.push(response.json().event.id as number);
  }
  return response;
}

async function getRealCategoryIds(app: ReturnType<typeof buildApp>): Promise<number[]> {
  const response = await app.inject({ method: "GET", url: "/v1/event-categories" });
  return (response.json().categories as Array<{ id: number }>).map((category) => category.id);
}

describe("POST /v1/events", () => {
  it("requires authentication", async () => {
    const app = buildApp();
    const countryId = await getIsolatedCountryId(app);

    const response = await app.inject({
      method: "POST",
      url: "/v1/events",
      payload: { countryId, title: "Unauthenticated Event", startsAt: futureIso(24) },
    });
    expect(response.statusCode).toBe(401);

    await app.close();
  });

  it("a regular user's submission starts pending and is hidden from the public listing", async () => {
    const app = buildApp();
    const countryId = await getIsolatedCountryId(app);
    const token = await createRegularToken(app, "pending");

    const response = await createEventViaApi(app, { countryId, token, title: "Regular User Event" });
    expect(response.statusCode).toBe(201);
    expect(response.json().event.status).toBe("pending");

    const publicList = await app.inject({ method: "GET", url: `/v1/events?countryId=${countryId}` });
    expect(publicList.json().events).toEqual([]);

    const publicGet = await app.inject({
      method: "GET",
      url: `/v1/events/${response.json().event.id}`,
    });
    expect(publicGet.statusCode).toBe(404);

    await app.close();
  });

  it("an admin's own submission is approved immediately and publicly visible", async () => {
    const app = buildApp();
    const countryId = await getIsolatedCountryId(app);
    const token = await createAdminToken(app, "auto-approve");

    const response = await createEventViaApi(app, { countryId, token, title: "Admin Event" });
    expect(response.statusCode).toBe(201);
    expect(response.json().event.status).toBe("approved");

    const publicList = await app.inject({ method: "GET", url: `/v1/events?countryId=${countryId}` });
    const ids = (publicList.json().events as Array<{ id: number }>).map((event) => event.id);
    expect(ids).toEqual([response.json().event.id]);

    await app.close();
  });

  it("never trusts a client-supplied status", async () => {
    const app = buildApp();
    const countryId = await getIsolatedCountryId(app);
    const token = await createRegularToken(app, "cant-self-approve");

    const response = await app.inject({
      method: "POST",
      url: "/v1/events",
      payload: {
        countryId,
        title: "Self-Approve Attempt",
        startsAt: futureIso(24),
        status: "approved",
      },
      headers: { authorization: `Bearer ${token}` },
    });
    // Fastify's AJV compiler runs with removeAdditional: true by default,
    // so createEventBodySchema's additionalProperties: false doesn't
    // reject a request carrying "status" - it silently strips it before
    // the handler ever sees it (same behavior as routes/users.ts's
    // registration body, verified there in
    // tests/users.validation.test.ts). Either way, a regular user's
    // submission still starts pending.
    expect(response.statusCode).toBe(201);
    createdEventIds.push(response.json().event.id as number);
    expect(response.json().event.status).toBe("pending");

    await app.close();
  });

  it("rejects an unknown countryId", async () => {
    const app = buildApp();
    const token = await createRegularToken(app, "bad-country");

    const response = await app.inject({
      method: "POST",
      url: "/v1/events",
      payload: { countryId: 999999999, title: "Bad Country Event", startsAt: futureIso(24) },
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().message).toMatch(/countryId/);

    await app.close();
  });

  it("rejects endsAt before startsAt", async () => {
    const app = buildApp();
    const countryId = await getIsolatedCountryId(app);
    const token = await createRegularToken(app, "bad-ends-at");

    const response = await app.inject({
      method: "POST",
      url: "/v1/events",
      payload: {
        countryId,
        title: "Backwards Event",
        startsAt: futureIso(24),
        endsAt: futureIso(1),
      },
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().message).toMatch(/endsAt/);

    await app.close();
  });

  it("accepts a null-equivalent (omitted) endsAt regardless of startsAt", async () => {
    const app = buildApp();
    const countryId = await getIsolatedCountryId(app);
    const token = await createRegularToken(app, "no-ends-at");

    const response = await createEventViaApi(app, {
      countryId,
      token,
      title: "Open-Ended Event",
      startsAt: futureIso(24),
    });
    expect(response.statusCode).toBe(201);
    expect(response.json().event.endsAt).toBeNull();

    await app.close();
  });

  it("rejects a non-HTTPS imageUrl/ticketUrl", async () => {
    const app = buildApp();
    const countryId = await getIsolatedCountryId(app);
    const token = await createRegularToken(app, "bad-url");

    const response = await app.inject({
      method: "POST",
      url: "/v1/events",
      payload: {
        countryId,
        title: "Insecure Url Event",
        startsAt: futureIso(24),
        imageUrl: "http://example.com/flyer.png",
      },
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(400);

    await app.close();
  });

  it("trims whitespace from free-text fields", async () => {
    const app = buildApp();
    const countryId = await getIsolatedCountryId(app);
    const token = await createRegularToken(app, "trims");

    const response = await app.inject({
      method: "POST",
      url: "/v1/events",
      payload: {
        countryId,
        title: "  Padded Title  ",
        venue: "  Padded Venue  ",
        startsAt: futureIso(24),
      },
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(201);
    createdEventIds.push(response.json().event.id as number);
    expect(response.json().event.title).toBe("Padded Title");
    expect(response.json().event.venue).toBe("Padded Venue");

    await app.close();
  });
});

describe("GET /v1/events and GET /v1/events/:id", () => {
  it("404s for a nonexistent event id", async () => {
    const app = buildApp();
    const response = await app.inject({ method: "GET", url: "/v1/events/999999999" });
    expect(response.statusCode).toBe(404);

    await app.close();
  });

  it("never includes an event from a different country", async () => {
    const app = buildApp();
    const [countryA, countryB] = await getIsolatedCountryIds(app);
    const token = await createAdminToken(app, "cross-country");

    const eventA = await createEventViaApi(app, { countryId: countryA, token, title: "Country A Event" });
    await createEventViaApi(app, { countryId: countryB, token, title: "Country B Event" });

    const response = await app.inject({ method: "GET", url: `/v1/events?countryId=${countryA}` });
    const ids = (response.json().events as Array<{ id: number }>).map((event) => event.id);
    expect(ids).toEqual([eventA.json().event.id]);

    await app.close();
  });

  it("orders soonest-first by startsAt", async () => {
    const app = buildApp();
    const countryId = await getIsolatedCountryId(app);
    const token = await createAdminToken(app, "ordering");

    const later = await createEventViaApi(app, {
      countryId,
      token,
      title: "Later Event",
      startsAt: futureIso(100),
    });
    const sooner = await createEventViaApi(app, {
      countryId,
      token,
      title: "Sooner Event",
      startsAt: futureIso(10),
    });

    const response = await app.inject({ method: "GET", url: `/v1/events?countryId=${countryId}` });
    const ids = (response.json().events as Array<{ id: number }>).map((event) => event.id);
    expect(ids).toEqual([sooner.json().event.id, later.json().event.id]);

    await app.close();
  });
});

describe("PATCH /v1/events/:id (moderation)", () => {
  it("requires an admin account", async () => {
    const app = buildApp();
    const countryId = await getIsolatedCountryId(app);
    const adminToken = await createAdminToken(app, "patch-admin-only");
    const regularToken = await createRegularToken(app, "patch-admin-only");

    const created = await createEventViaApi(app, { countryId, token: adminToken, title: "Gate Test Event" });
    const eventId = created.json().event.id as number;

    const response = await app.inject({
      method: "PATCH",
      url: `/v1/events/${eventId}`,
      payload: { status: "approved" },
      headers: { authorization: `Bearer ${regularToken}` },
    });
    expect(response.statusCode).toBe(403);

    await app.close();
  });

  it("an admin can approve a pending submission, making it publicly visible", async () => {
    const app = buildApp();
    const countryId = await getIsolatedCountryId(app);
    const adminToken = await createAdminToken(app, "approve");
    const regularToken = await createRegularToken(app, "approve");

    const created = await createEventViaApi(app, {
      countryId,
      token: regularToken,
      title: "To Be Approved Event",
    });
    const eventId = created.json().event.id as number;

    const beforeApproval = await app.inject({ method: "GET", url: `/v1/events/${eventId}` });
    expect(beforeApproval.statusCode).toBe(404);

    const patch = await app.inject({
      method: "PATCH",
      url: `/v1/events/${eventId}`,
      payload: { status: "approved" },
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(patch.statusCode).toBe(200);
    expect(patch.json().event.status).toBe("approved");

    const afterApproval = await app.inject({ method: "GET", url: `/v1/events/${eventId}` });
    expect(afterApproval.statusCode).toBe(200);

    await app.close();
  });

  it("an admin can reject a pending submission", async () => {
    const app = buildApp();
    const countryId = await getIsolatedCountryId(app);
    const adminToken = await createAdminToken(app, "reject");
    const regularToken = await createRegularToken(app, "reject");

    const created = await createEventViaApi(app, {
      countryId,
      token: regularToken,
      title: "To Be Rejected Event",
    });
    const eventId = created.json().event.id as number;

    const patch = await app.inject({
      method: "PATCH",
      url: `/v1/events/${eventId}`,
      payload: { status: "rejected" },
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(patch.statusCode).toBe(200);
    expect(patch.json().event.status).toBe("rejected");

    const publicGet = await app.inject({ method: "GET", url: `/v1/events/${eventId}` });
    expect(publicGet.statusCode).toBe(404);

    await app.close();
  });

  it("404s for a nonexistent event id", async () => {
    const app = buildApp();
    const adminToken = await createAdminToken(app, "patch-missing");

    const response = await app.inject({
      method: "PATCH",
      url: "/v1/events/999999999",
      payload: { status: "approved" },
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(response.statusCode).toBe(404);

    await app.close();
  });
});

describe("DELETE /v1/events/:id", () => {
  it("requires an admin account", async () => {
    const app = buildApp();
    const countryId = await getIsolatedCountryId(app);
    const adminToken = await createAdminToken(app, "delete-admin-only");
    const regularToken = await createRegularToken(app, "delete-admin-only");

    const created = await createEventViaApi(app, { countryId, token: adminToken, title: "Delete Gate Event" });
    const eventId = created.json().event.id as number;

    const response = await app.inject({
      method: "DELETE",
      url: `/v1/events/${eventId}`,
      headers: { authorization: `Bearer ${regularToken}` },
    });
    expect(response.statusCode).toBe(403);

    await app.close();
  });

  it("permanently removes an event", async () => {
    const app = buildApp();
    const countryId = await getIsolatedCountryId(app);
    const adminToken = await createAdminToken(app, "delete");

    const created = await createEventViaApi(app, { countryId, token: adminToken, title: "Deletable Event" });
    const eventId = created.json().event.id as number;

    const response = await app.inject({
      method: "DELETE",
      url: `/v1/events/${eventId}`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(response.statusCode).toBe(204);

    const adminList = await app.inject({
      method: "GET",
      url: `/v1/admin/events?countryId=${countryId}`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(adminList.json().events).toEqual([]);

    await app.close();
  });
});

describe("GET /v1/admin/events (moderation queue)", () => {
  it("requires an admin account", async () => {
    const app = buildApp();
    const regularToken = await createRegularToken(app, "queue-admin-only");

    const response = await app.inject({
      method: "GET",
      url: "/v1/admin/events",
      headers: { authorization: `Bearer ${regularToken}` },
    });
    expect(response.statusCode).toBe(403);

    await app.close();
  });

  it("shows pending, approved, and rejected submissions all at once", async () => {
    const app = buildApp();
    const countryId = await getIsolatedCountryId(app);
    const adminToken = await createAdminToken(app, "queue-all");
    const regularToken = await createRegularToken(app, "queue-all");

    const pending = await createEventViaApi(app, {
      countryId,
      token: regularToken,
      title: "Queue Pending Event",
    });
    const approved = await createEventViaApi(app, {
      countryId,
      token: adminToken,
      title: "Queue Approved Event",
    });
    const rejectedCreated = await createEventViaApi(app, {
      countryId,
      token: regularToken,
      title: "Queue Rejected Event",
    });
    await app.inject({
      method: "PATCH",
      url: `/v1/events/${rejectedCreated.json().event.id}`,
      payload: { status: "rejected" },
      headers: { authorization: `Bearer ${adminToken}` },
    });

    const response = await app.inject({
      method: "GET",
      url: `/v1/admin/events?countryId=${countryId}`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    const byId = new Map(
      (response.json().events as Array<{ id: number; status: string }>).map((event) => [event.id, event.status]),
    );
    expect(byId.get(pending.json().event.id as number)).toBe("pending");
    expect(byId.get(approved.json().event.id as number)).toBe("approved");
    expect(byId.get(rejectedCreated.json().event.id as number)).toBe("rejected");

    await app.close();
  });

  it("filters to exactly one status when requested", async () => {
    const app = buildApp();
    const countryId = await getIsolatedCountryId(app);
    const adminToken = await createAdminToken(app, "queue-filter");
    const regularToken = await createRegularToken(app, "queue-filter");

    const pending = await createEventViaApi(app, {
      countryId,
      token: regularToken,
      title: "Filter Pending Event",
    });
    await createEventViaApi(app, { countryId, token: adminToken, title: "Filter Approved Event" });

    const response = await app.inject({
      method: "GET",
      url: `/v1/admin/events?countryId=${countryId}&status=pending`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    const ids = (response.json().events as Array<{ id: number }>).map((event) => event.id);
    expect(ids).toEqual([pending.json().event.id]);

    await app.close();
  });
});

describe("Event categories (Step 25)", () => {
  it("defaults to an empty categories array when none are attached", async () => {
    const app = buildApp();
    const countryId = await getIsolatedCountryId(app);
    const token = await createAdminToken(app, "no-categories");

    const created = await createEventViaApi(app, { countryId, token, title: "No Category Event" });
    expect(created.json().event.categories).toEqual([]);

    await app.close();
  });

  it("attaches categories on create and returns them hydrated", async () => {
    const app = buildApp();
    const countryId = await getIsolatedCountryId(app);
    const token = await createAdminToken(app, "attach-categories");
    const [categoryA, categoryB] = await getRealCategoryIds(app);

    const created = await createEventViaApi(app, {
      countryId,
      token,
      title: "Categorized Event",
      categoryIds: [categoryA, categoryB],
    });
    expect(created.statusCode).toBe(201);
    const categories = created.json().event.categories as Array<{ id: number; name: string }>;
    expect(categories.map((c) => c.id).sort((a, b) => a - b)).toEqual(
      [categoryA, categoryB].sort((a, b) => a - b),
    );

    await app.close();
  });

  it("rejects an unknown categoryId on create", async () => {
    const app = buildApp();
    const countryId = await getIsolatedCountryId(app);
    const token = await createRegularToken(app, "bad-category");

    const response = await app.inject({
      method: "POST",
      url: "/v1/events",
      payload: {
        countryId,
        title: "Bad Category Event",
        startsAt: futureIso(24),
        categoryIds: [999999999],
      },
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().message).toMatch(/categoryIds/);

    await app.close();
  });

  it("PATCH replaces the full category set, and omitting categoryIds leaves it untouched", async () => {
    const app = buildApp();
    const countryId = await getIsolatedCountryId(app);
    const token = await createAdminToken(app, "replace-categories");
    const [categoryA, categoryB, categoryC] = await getRealCategoryIds(app);

    const created = await createEventViaApi(app, {
      countryId,
      token,
      title: "Replaceable Category Event",
      categoryIds: [categoryA],
    });
    const eventId = created.json().event.id as number;

    const replaced = await app.inject({
      method: "PATCH",
      url: `/v1/events/${eventId}`,
      payload: { categoryIds: [categoryB, categoryC] },
      headers: { authorization: `Bearer ${token}` },
    });
    expect(replaced.statusCode).toBe(200);
    const replacedIds = (replaced.json().event.categories as Array<{ id: number }>)
      .map((c) => c.id)
      .sort((a, b) => a - b);
    expect(replacedIds).toEqual([categoryB, categoryC].sort((a, b) => a - b));

    const untouched = await app.inject({
      method: "PATCH",
      url: `/v1/events/${eventId}`,
      payload: { title: "Renamed, Categories Untouched" },
      headers: { authorization: `Bearer ${token}` },
    });
    expect(untouched.statusCode).toBe(200);
    const untouchedIds = (untouched.json().event.categories as Array<{ id: number }>)
      .map((c) => c.id)
      .sort((a, b) => a - b);
    expect(untouchedIds).toEqual([categoryB, categoryC].sort((a, b) => a - b));

    await app.close();
  });

  it("PATCH with an empty categoryIds array clears every category", async () => {
    const app = buildApp();
    const countryId = await getIsolatedCountryId(app);
    const token = await createAdminToken(app, "clear-categories");
    const [categoryA] = await getRealCategoryIds(app);

    const created = await createEventViaApi(app, {
      countryId,
      token,
      title: "Clearable Category Event",
      categoryIds: [categoryA],
    });
    const eventId = created.json().event.id as number;

    const cleared = await app.inject({
      method: "PATCH",
      url: `/v1/events/${eventId}`,
      payload: { categoryIds: [] },
      headers: { authorization: `Bearer ${token}` },
    });
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json().event.categories).toEqual([]);

    await app.close();
  });

  it("GET /v1/events?categoryId= filters to events tagged with that category", async () => {
    const app = buildApp();
    const countryId = await getIsolatedCountryId(app);
    const token = await createAdminToken(app, "filter-category");
    const [categoryA, categoryB] = await getRealCategoryIds(app);

    const taggedA = await createEventViaApi(app, {
      countryId,
      token,
      title: "Filter Category A Event",
      categoryIds: [categoryA],
    });
    await createEventViaApi(app, {
      countryId,
      token,
      title: "Filter Category B Event",
      categoryIds: [categoryB],
    });

    const response = await app.inject({
      method: "GET",
      url: `/v1/events?countryId=${countryId}&categoryId=${categoryA}`,
    });
    const ids = (response.json().events as Array<{ id: number }>).map((event) => event.id);
    expect(ids).toEqual([taggedA.json().event.id]);

    await app.close();
  });
});

describe("Event search and date-range filtering (Step 26)", () => {
  it("q filters case-insensitively by a substring of the title", async () => {
    const app = buildApp();
    const countryId = await getIsolatedCountryId(app);
    const token = await createAdminToken(app, "search-title");

    const alpha = await createEventViaApi(app, {
      countryId,
      token,
      title: "Search Target Alpha Event",
    });
    await createEventViaApi(app, { countryId, token, title: "Search Target Beta Event" });

    const response = await app.inject({
      method: "GET",
      url: `/v1/events?countryId=${countryId}&q=alpha`,
    });
    const ids = (response.json().events as Array<{ id: number }>).map((event) => event.id);
    expect(ids).toEqual([alpha.json().event.id]);

    await app.close();
  });

  it("startsAfter/startsBefore filter an inclusive date-time range against startsAt", async () => {
    const app = buildApp();
    const countryId = await getIsolatedCountryId(app);
    const token = await createAdminToken(app, "date-range");

    const soon = await createEventViaApi(app, {
      countryId,
      token,
      title: "Date Range Soon Event",
      startsAt: futureIso(10),
    });
    const later = await createEventViaApi(app, {
      countryId,
      token,
      title: "Date Range Later Event",
      startsAt: futureIso(100),
    });

    const afterOnly = await app.inject({
      method: "GET",
      url: `/v1/events?countryId=${countryId}&startsAfter=${encodeURIComponent(futureIso(50))}`,
    });
    expect(
      (afterOnly.json().events as Array<{ id: number }>).map((event) => event.id),
    ).toEqual([later.json().event.id]);

    const beforeOnly = await app.inject({
      method: "GET",
      url: `/v1/events?countryId=${countryId}&startsBefore=${encodeURIComponent(futureIso(50))}`,
    });
    expect(
      (beforeOnly.json().events as Array<{ id: number }>).map((event) => event.id),
    ).toEqual([soon.json().event.id]);

    // The bounds are inclusive: filtering with the exact startsAt of an
    // event as both edges of the range must still include that event.
    const exactBoundary = await app.inject({
      method: "GET",
      url:
        `/v1/events?countryId=${countryId}` +
        `&startsAfter=${encodeURIComponent(soon.json().event.startsAt)}` +
        `&startsBefore=${encodeURIComponent(soon.json().event.startsAt)}`,
    });
    expect(
      (exactBoundary.json().events as Array<{ id: number }>).map((event) => event.id),
    ).toEqual([soon.json().event.id]);

    await app.close();
  });

  it("rejects startsAfter after startsBefore", async () => {
    const app = buildApp();
    const countryId = await getIsolatedCountryId(app);

    const response = await app.inject({
      method: "GET",
      url:
        `/v1/events?countryId=${countryId}` +
        `&startsAfter=${encodeURIComponent(futureIso(100))}` +
        `&startsBefore=${encodeURIComponent(futureIso(10))}`,
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().message).toMatch(/startsAfter/);

    await app.close();
  });

  it("GET /v1/admin/events supports the same q and date-range filters", async () => {
    const app = buildApp();
    const countryId = await getIsolatedCountryId(app);
    const adminToken = await createAdminToken(app, "admin-search");
    const regularToken = await createRegularToken(app, "admin-search");

    const matching = await createEventViaApi(app, {
      countryId,
      token: regularToken,
      title: "Admin Search Zebra Event",
      startsAt: futureIso(10),
    });
    await createEventViaApi(app, {
      countryId,
      token: regularToken,
      title: "Admin Search Walrus Event",
      startsAt: futureIso(10),
    });

    const response = await app.inject({
      method: "GET",
      url: `/v1/admin/events?countryId=${countryId}&q=Zebra&startsBefore=${encodeURIComponent(futureIso(50))}`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    const ids = (response.json().events as Array<{ id: number }>).map((event) => event.id);
    expect(ids).toEqual([matching.json().event.id]);

    await app.close();
  });
});

describe("Event moderation audit trail (Step 27)", () => {
  it("a regular user's pending submission is unmoderated", async () => {
    const app = buildApp();
    const countryId = await getIsolatedCountryId(app);
    const token = await createRegularToken(app, "unmoderated");

    const created = await createEventViaApi(app, {
      countryId,
      token,
      title: "Unmoderated Submission Event",
    });
    expect(created.json().event.status).toBe("pending");
    expect(created.json().event.moderatedAt).toBeNull();
    expect(created.json().event.moderatedByUserId).toBeNull();
    expect(created.json().event.moderationReason).toBeNull();

    await app.close();
  });

  it("an admin's own auto-approved submission is recorded as moderated by that same admin", async () => {
    const app = buildApp();
    const countryId = await getIsolatedCountryId(app);
    const { token, userId: adminId } = await createAdminAccount(app, "self-moderate");

    const created = await createEventViaApi(app, {
      countryId,
      token,
      title: "Self-Approved Admin Event",
    });
    expect(created.json().event.status).toBe("approved");
    expect(created.json().event.moderatedByUserId).toBe(adminId);
    expect(created.json().event.moderatedAt).not.toBeNull();
    expect(created.json().event.moderationReason).toBeNull();

    await app.close();
  });

  it("an admin approving a pending submission is recorded as the moderator", async () => {
    const app = buildApp();
    const countryId = await getIsolatedCountryId(app);
    const { token: adminToken, userId: adminId } = await createAdminAccount(app, "approve-attrib");
    const regularToken = await createRegularToken(app, "approve-attrib");

    const created = await createEventViaApi(app, {
      countryId,
      token: regularToken,
      title: "To Be Attributed Event",
    });
    const eventId = created.json().event.id as number;
    expect(created.json().event.moderatedByUserId).toBeNull();

    const patch = await app.inject({
      method: "PATCH",
      url: `/v1/events/${eventId}`,
      payload: { status: "approved" },
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(patch.json().event.moderatedByUserId).toBe(adminId);
    expect(patch.json().event.moderatedAt).not.toBeNull();

    await app.close();
  });

  it("a rejection can include a moderationReason", async () => {
    const app = buildApp();
    const countryId = await getIsolatedCountryId(app);
    const adminToken = await createAdminToken(app, "reject-reason");
    const regularToken = await createRegularToken(app, "reject-reason");

    const created = await createEventViaApi(app, {
      countryId,
      token: regularToken,
      title: "Rejected With Reason Event",
    });
    const eventId = created.json().event.id as number;

    const patch = await app.inject({
      method: "PATCH",
      url: `/v1/events/${eventId}`,
      payload: { status: "rejected", moderationReason: "  Duplicate of an existing listing  " },
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(patch.statusCode).toBe(200);
    expect(patch.json().event.status).toBe("rejected");
    expect(patch.json().event.moderationReason).toBe("Duplicate of an existing listing");

    await app.close();
  });

  it("rejects a moderationReason without status in the same request", async () => {
    const app = buildApp();
    const countryId = await getIsolatedCountryId(app);
    const adminToken = await createAdminToken(app, "reason-without-status");

    const created = await createEventViaApi(app, {
      countryId,
      token: adminToken,
      title: "Reason Without Status Event",
    });
    const eventId = created.json().event.id as number;

    const response = await app.inject({
      method: "PATCH",
      url: `/v1/events/${eventId}`,
      payload: { moderationReason: "This should be rejected" },
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().message).toMatch(/moderationReason/);

    await app.close();
  });

  it("a PATCH that doesn't touch status leaves the moderation record untouched", async () => {
    const app = buildApp();
    const countryId = await getIsolatedCountryId(app);
    const { token, userId: adminId } = await createAdminAccount(app, "leave-untouched");

    const created = await createEventViaApi(app, {
      countryId,
      token,
      title: "Untouched Moderation Event",
    });
    const originalModeratedAt = created.json().event.moderatedAt as string;
    expect(created.json().event.moderatedByUserId).toBe(adminId);

    const patch = await app.inject({
      method: "PATCH",
      url: `/v1/events/${created.json().event.id}`,
      payload: { title: "Untouched Moderation Event (Renamed)" },
      headers: { authorization: `Bearer ${token}` },
    });
    expect(patch.statusCode).toBe(200);
    expect(patch.json().event.moderatedByUserId).toBe(adminId);
    expect(patch.json().event.moderatedAt).toBe(originalModeratedAt);

    await app.close();
  });
});

describe("Duplicate event detection (Step 28)", () => {
  it("rejects an exact re-submission (same country, title, startsAt) with 409", async () => {
    const app = buildApp();
    const countryId = await getIsolatedCountryId(app);
    const token = await createAdminToken(app, "exact-duplicate");
    const startsAt = futureIso(24);

    const first = await createEventViaApi(app, {
      countryId,
      token,
      title: "Duplicate Detection Event",
      startsAt,
    });
    expect(first.statusCode).toBe(201);

    // createEventViaApi, not a raw app.inject - it tracks the created id
    // for afterEach cleanup regardless of the response status, so if a
    // future regression ever makes this call unexpectedly succeed (the
    // exact failure mode this test exists to catch), the real row it
    // creates gets cleaned up rather than silently polluting the shared
    // test database the way an untracked app.inject call once did here.
    const second = await createEventViaApi(app, {
      countryId,
      token,
      title: "Duplicate Detection Event",
      startsAt,
    });
    expect(second.statusCode).toBe(409);

    await app.close();
  });

  it("catches a near-duplicate title differing only in case and whitespace", async () => {
    const app = buildApp();
    const countryId = await getIsolatedCountryId(app);
    const token = await createAdminToken(app, "case-duplicate");
    const startsAt = futureIso(24);

    const first = await createEventViaApi(app, {
      countryId,
      token,
      title: "Sunset Beach Festival",
      startsAt,
    });
    expect(first.statusCode).toBe(201);

    // createEventViaApi, not a raw app.inject - see the identical
    // comment on the exact-re-submission test above for why.
    const second = await createEventViaApi(app, {
      countryId,
      token,
      title: "  sunset   beach FESTIVAL  ",
      startsAt,
    });
    expect(second.statusCode).toBe(409);

    await app.close();
  });

  it("does not flag the same title at a different startsAt as a duplicate", async () => {
    const app = buildApp();
    const countryId = await getIsolatedCountryId(app);
    const token = await createAdminToken(app, "different-time");

    const first = await createEventViaApi(app, {
      countryId,
      token,
      title: "Weekly Open Mic",
      startsAt: futureIso(24),
    });
    expect(first.statusCode).toBe(201);

    const second = await createEventViaApi(app, {
      countryId,
      token,
      title: "Weekly Open Mic",
      startsAt: futureIso(24 * 8),
    });
    expect(second.statusCode).toBe(201);

    await app.close();
  });

  it("does not flag the same title/time in a different country as a duplicate", async () => {
    const app = buildApp();
    const [countryA, countryB] = await getIsolatedCountryIds(app);
    const token = await createAdminToken(app, "different-country");
    const startsAt = futureIso(24);

    const first = await createEventViaApi(app, {
      countryId: countryA,
      token,
      title: "Cross-Country Duplicate Title",
      startsAt,
    });
    expect(first.statusCode).toBe(201);

    const second = await createEventViaApi(app, {
      countryId: countryB,
      token,
      title: "Cross-Country Duplicate Title",
      startsAt,
    });
    expect(second.statusCode).toBe(201);

    await app.close();
  });

  it("frees up a title/time for resubmission once the original is rejected", async () => {
    const app = buildApp();
    const countryId = await getIsolatedCountryId(app);
    const adminToken = await createAdminToken(app, "rejected-frees-up");
    const startsAt = futureIso(24);

    const first = await createEventViaApi(app, {
      countryId,
      token: adminToken,
      title: "Resubmittable Event",
      startsAt,
    });
    await app.inject({
      method: "PATCH",
      url: `/v1/events/${first.json().event.id}`,
      payload: { status: "rejected" },
      headers: { authorization: `Bearer ${adminToken}` },
    });

    const second = await createEventViaApi(app, {
      countryId,
      token: adminToken,
      title: "Resubmittable Event",
      startsAt,
    });
    expect(second.statusCode).toBe(201);

    await app.close();
  });

  it("rejects a PATCH that would rename an event into a duplicate of another", async () => {
    const app = buildApp();
    const countryId = await getIsolatedCountryId(app);
    const token = await createAdminToken(app, "patch-into-duplicate");
    const startsAt = futureIso(24);

    await createEventViaApi(app, {
      countryId,
      token,
      title: "Already Taken Title",
      startsAt,
    });
    const toRename = await createEventViaApi(app, {
      countryId,
      token,
      title: "Not Yet Taken Title",
      startsAt,
    });

    const response = await app.inject({
      method: "PATCH",
      url: `/v1/events/${toRename.json().event.id}`,
      payload: { title: "Already Taken Title" },
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(409);

    await app.close();
  });
});

function pastIso(hoursAgo: number): string {
  return new Date(Date.now() - hoursAgo * 60 * 60 * 1000).toISOString();
}

describe("Excluding concluded events by default (Step 29)", () => {
  it("excludes a concluded event (past startsAt, no endsAt) from the default public listing", async () => {
    const app = buildApp();
    const countryId = await getIsolatedCountryId(app);
    const token = await createAdminToken(app, "exclude-past");

    await createEventViaApi(app, {
      countryId,
      token,
      title: "Already Happened Event",
      startsAt: pastIso(24),
    });
    const upcoming = await createEventViaApi(app, {
      countryId,
      token,
      title: "Still Upcoming Event",
      startsAt: futureIso(24),
    });

    const response = await app.inject({ method: "GET", url: `/v1/events?countryId=${countryId}` });
    const ids = (response.json().events as Array<{ id: number }>).map((event) => event.id);
    expect(ids).toEqual([upcoming.json().event.id]);

    await app.close();
  });

  it("includePast=true includes a concluded event in the public listing", async () => {
    const app = buildApp();
    const countryId = await getIsolatedCountryId(app);
    const token = await createAdminToken(app, "include-past");

    const past = await createEventViaApi(app, {
      countryId,
      token,
      title: "Included Past Event",
      startsAt: pastIso(24),
    });
    const upcoming = await createEventViaApi(app, {
      countryId,
      token,
      title: "Included Upcoming Event",
      startsAt: futureIso(24),
    });

    const response = await app.inject({
      method: "GET",
      url: `/v1/events?countryId=${countryId}&includePast=true`,
    });
    const ids = (response.json().events as Array<{ id: number }>).map((event) => event.id);
    expect(new Set(ids)).toEqual(new Set([past.json().event.id, upcoming.json().event.id]));

    await app.close();
  });

  it("an ongoing event (past startsAt, future endsAt) is not treated as concluded", async () => {
    const app = buildApp();
    const countryId = await getIsolatedCountryId(app);
    const token = await createAdminToken(app, "ongoing-event");

    const ongoing = await createEventViaApi(app, {
      countryId,
      token,
      title: "Ongoing Multi-Day Event",
      startsAt: pastIso(24),
      endsAt: futureIso(24),
    });

    const response = await app.inject({ method: "GET", url: `/v1/events?countryId=${countryId}` });
    const ids = (response.json().events as Array<{ id: number }>).map((event) => event.id);
    expect(ids).toEqual([ongoing.json().event.id]);

    await app.close();
  });

  it("GET /v1/admin/events shows both past and upcoming by default, unlike the public route", async () => {
    const app = buildApp();
    const countryId = await getIsolatedCountryId(app);
    const adminToken = await createAdminToken(app, "admin-sees-past");

    const past = await createEventViaApi(app, {
      countryId,
      token: adminToken,
      title: "Admin Visible Past Event",
      startsAt: pastIso(24),
    });
    const upcoming = await createEventViaApi(app, {
      countryId,
      token: adminToken,
      title: "Admin Visible Upcoming Event",
      startsAt: futureIso(24),
    });

    const response = await app.inject({
      method: "GET",
      url: `/v1/admin/events?countryId=${countryId}`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    const ids = (response.json().events as Array<{ id: number }>).map((event) => event.id);
    expect(new Set(ids)).toEqual(new Set([past.json().event.id, upcoming.json().event.id]));

    await app.close();
  });

  it("GET /v1/admin/events?upcomingOnly=true narrows to just what hasn't concluded", async () => {
    const app = buildApp();
    const countryId = await getIsolatedCountryId(app);
    const adminToken = await createAdminToken(app, "admin-upcoming-only");

    await createEventViaApi(app, {
      countryId,
      token: adminToken,
      title: "Admin Filtered Past Event",
      startsAt: pastIso(24),
    });
    const upcoming = await createEventViaApi(app, {
      countryId,
      token: adminToken,
      title: "Admin Filtered Upcoming Event",
      startsAt: futureIso(24),
    });

    const response = await app.inject({
      method: "GET",
      url: `/v1/admin/events?countryId=${countryId}&upcomingOnly=true`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    const ids = (response.json().events as Array<{ id: number }>).map((event) => event.id);
    expect(ids).toEqual([upcoming.json().event.id]);

    await app.close();
  });
});
