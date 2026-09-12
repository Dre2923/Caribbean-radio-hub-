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
    },
    headers: { authorization: `Bearer ${options.token}` },
  });
  if (response.statusCode === 201) {
    createdEventIds.push(response.json().event.id as number);
  }
  return response;
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
