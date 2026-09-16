// Step 62 (Background Update Workers, part one): the User Features digest.
// Tests both the repository-level candidate query (listUsersDueForWeeklyDigest/
// markWeeklyDigestChecked) and the worker's own evaluation logic
// (evaluateWeeklyDigestCandidates), the same "repository correctness,
// then the orchestration built on top of it" split already used by
// tests/favoriteStationAvailabilityNotifier.test.ts for Step 54's own
// worker-adjacent notifier.

import { afterAll, afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { pool } from "../src/db/pool.js";
import { setUserRole, updateUserProfile } from "../src/repositories/usersRepository.js";
import {
  listUsersDueForWeeklyDigest,
  markWeeklyDigestChecked,
  updateNotificationPreferences,
} from "../src/repositories/notificationPreferencesRepository.js";
import { evaluateWeeklyDigestCandidates } from "../src/notifications/weeklyEventsDigestWorker.js";
import { InvalidPushTokenError, type PushMessage, type PushProvider } from "../src/notifications/types.js";

afterAll(async () => {
  await pool.end();
});

class FakePushProvider implements PushProvider {
  sent: PushMessage[] = [];
  failTokens = new Set<string>();

  async send(message: PushMessage): Promise<void> {
    if (this.failTokens.has(message.token)) {
      throw new InvalidPushTokenError(message.token, "test-forced failure");
    }
    this.sent.push(message);
  }
}

let createdUserIds: number[] = [];
let createdEventIds: number[] = [];
let nextCountryOffset = 0;

afterEach(async () => {
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
  const usableCountries = countries.slice(1);
  if (usableCountries.length === 0) throw new Error("expected at least 2 seeded countries");
  const country = usableCountries[nextCountryOffset % usableCountries.length];
  nextCountryOffset++;
  return country.id;
}

async function createAdminAccount(
  app: ReturnType<typeof buildApp>,
  label: string,
): Promise<{ token: string; userId: number }> {
  const email = `digest-admin-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
  const password = "digest-admin-password-123";
  const register = await app.inject({
    method: "POST",
    url: "/v1/users",
    payload: { email, password, displayName: "Digest Admin" },
  });
  const userId = register.json().user.id as number;
  createdUserIds.push(userId);
  await setUserRole(userId, "admin");
  const login = await app.inject({ method: "POST", url: "/v1/auth/login", payload: { email, password } });
  return { token: login.json().token as string, userId };
}

async function createRegularAccount(
  app: ReturnType<typeof buildApp>,
  label: string,
  countryId?: number,
): Promise<{ token: string; userId: number }> {
  const email = `digest-user-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
  const password = "digest-user-password-123";
  const register = await app.inject({
    method: "POST",
    url: "/v1/users",
    payload: { email, password, displayName: "Digest Regular User" },
  });
  const userId = register.json().user.id as number;
  createdUserIds.push(userId);
  if (countryId !== undefined) {
    await updateUserProfile(userId, { countryId });
  }
  const login = await app.inject({ method: "POST", url: "/v1/auth/login", payload: { email, password } });
  return { token: login.json().token as string, userId };
}

function futureIso(hoursFromNow: number): string {
  return new Date(Date.now() + hoursFromNow * 60 * 60 * 1000).toISOString();
}

async function createApprovedEvent(
  app: ReturnType<typeof buildApp>,
  adminToken: string,
  countryId: number,
  title: string,
): Promise<number> {
  const response = await app.inject({
    method: "POST",
    url: "/v1/events",
    payload: { countryId, title, startsAt: futureIso(24) },
    headers: { authorization: `Bearer ${adminToken}` },
  });
  expect(response.statusCode).toBe(201);
  expect(response.json().event.status).toBe("approved");
  const eventId = response.json().event.id as number;
  createdEventIds.push(eventId);
  return eventId;
}

async function registerPushToken(app: ReturnType<typeof buildApp>, token: string, deviceToken: string) {
  const response = await app.inject({
    method: "POST",
    url: "/v1/me/push-tokens",
    payload: { token: deviceToken, platform: "android" },
    headers: { authorization: `Bearer ${token}` },
  });
  expect(response.statusCode).toBe(204);
}

describe("listUsersDueForWeeklyDigest / markWeeklyDigestChecked (Step 62)", () => {
  it("only returns a user with weeklyEventsDigest opted in and a profile country set", async () => {
    const app = buildApp();
    const countryId = await getIsolatedCountryId(app);
    const { userId: optedInId, token: optedInToken } = await createRegularAccount(
      app,
      "opted-in",
      countryId,
    );
    await updateNotificationPreferences(optedInId, { weeklyEventsDigest: true });
    const { userId: optedOutId } = await createRegularAccount(app, "opted-out", countryId);
    const { userId: noCountryId } = await createRegularAccount(app, "no-country");
    await updateNotificationPreferences(noCountryId, { weeklyEventsDigest: true });

    const farFutureCutoff = new Date(Date.now() + 1000).toISOString();
    const candidates = await listUsersDueForWeeklyDigest(farFutureCutoff);
    const candidateIds = candidates.map((c) => c.userId);

    expect(candidateIds).toContain(optedInId);
    expect(candidateIds).not.toContain(optedOutId);
    expect(candidateIds).not.toContain(noCountryId);
    // The returned country is the user's own real profile country, not a
    // placeholder.
    expect(candidates.find((c) => c.userId === optedInId)).toEqual({
      userId: optedInId,
      countryId,
    });

    void optedInToken;
    await app.close();
  });

  it("excludes a user checked more recently than the given cutoff, includes one checked before it", async () => {
    const app = buildApp();
    const countryId = await getIsolatedCountryId(app);
    const { userId: recentlyCheckedId } = await createRegularAccount(app, "recent", countryId);
    await updateNotificationPreferences(recentlyCheckedId, { weeklyEventsDigest: true });
    await markWeeklyDigestChecked(recentlyCheckedId);

    const { userId: neverCheckedId } = await createRegularAccount(app, "never-checked", countryId);
    await updateNotificationPreferences(neverCheckedId, { weeklyEventsDigest: true });

    // A cutoff far in the past: the just-checked user's last_digest_check_at
    // (now) is not before it, so they're excluded; the never-checked user
    // (NULL) is always included regardless of the cutoff.
    const pastCutoff = new Date(Date.now() - 1000).toISOString();
    const candidates = await listUsersDueForWeeklyDigest(pastCutoff);
    const candidateIds = candidates.map((c) => c.userId);
    expect(candidateIds).not.toContain(recentlyCheckedId);
    expect(candidateIds).toContain(neverCheckedId);

    // Once the cutoff moves earlier than the just-checked timestamp, that
    // user becomes due again too.
    const farFutureCutoff = new Date(Date.now() + 1000).toISOString();
    const candidatesAfter = await listUsersDueForWeeklyDigest(farFutureCutoff);
    expect(candidatesAfter.map((c) => c.userId)).toContain(recentlyCheckedId);

    await app.close();
  });
});

describe("evaluateWeeklyDigestCandidates (Step 62)", () => {
  it("sends a digest naming a real upcoming approved event in the user's own country", async () => {
    const app = buildApp();
    const countryId = await getIsolatedCountryId(app);
    const { token: adminToken } = await createAdminAccount(app, "digest-content");
    const { userId, token } = await createRegularAccount(app, "digest-content", countryId);
    await registerPushToken(app, token, `device-digest-${Date.now()}`);
    const marker = `Digest Event ${Date.now()}${Math.random().toString(36).slice(2)}`;
    await createApprovedEvent(app, adminToken, countryId, marker);

    const fakeProvider = new FakePushProvider();
    await evaluateWeeklyDigestCandidates([{ userId, countryId }], fakeProvider);

    expect(fakeProvider.sent).toHaveLength(1);
    expect(fakeProvider.sent[0].body).toContain(marker);
    expect(fakeProvider.sent[0].title).toMatch(/event/i);

    // Marked checked as a side effect of evaluation.
    const farFutureCutoff = new Date(Date.now() + 1000).toISOString();
    const stillDue = await listUsersDueForWeeklyDigest(farFutureCutoff);
    expect(stillDue.map((c) => c.userId)).not.toContain(userId);

    await app.close();
  });

  it("sends nothing but still marks the user checked when there are no upcoming events in their country", async () => {
    const app = buildApp();
    const countryId = await getIsolatedCountryId(app);
    const { userId, token } = await createRegularAccount(app, "no-events", countryId);
    await registerPushToken(app, token, `device-no-events-${Date.now()}`);

    const fakeProvider = new FakePushProvider();
    await evaluateWeeklyDigestCandidates([{ userId, countryId }], fakeProvider);

    expect(fakeProvider.sent).toHaveLength(0);

    // Still marked checked - see last_digest_check_at's own migration
    // comment for why "evaluated" and "had something to send" are
    // deliberately different things.
    const farFutureCutoff = new Date(Date.now() + 1000).toISOString();
    const stillDue = await listUsersDueForWeeklyDigest(farFutureCutoff);
    expect(stillDue.map((c) => c.userId)).not.toContain(userId);

    await app.close();
  });

  it("never names a different country's event", async () => {
    const app = buildApp();
    const countryA = await getIsolatedCountryId(app);
    const countryB = await getIsolatedCountryId(app);
    const { token: adminToken } = await createAdminAccount(app, "cross-country");
    const { userId, token } = await createRegularAccount(app, "cross-country", countryA);
    await registerPushToken(app, token, `device-cross-country-${Date.now()}`);
    await createApprovedEvent(app, adminToken, countryB, `Other Country Event ${Date.now()}`);

    const fakeProvider = new FakePushProvider();
    await evaluateWeeklyDigestCandidates([{ userId, countryId: countryA }], fakeProvider);

    expect(fakeProvider.sent).toHaveLength(0);

    await app.close();
  });

  it("isolates a dead push token's failure and cleans it up, without blocking markWeeklyDigestChecked", async () => {
    const app = buildApp();
    const countryId = await getIsolatedCountryId(app);
    const { token: adminToken } = await createAdminAccount(app, "dead-token");
    const { userId, token } = await createRegularAccount(app, "dead-token", countryId);
    const deadToken = `device-dead-digest-${Date.now()}`;
    await registerPushToken(app, token, deadToken);
    await createApprovedEvent(app, adminToken, countryId, `Dead Token Event ${Date.now()}`);

    const fakeProvider = new FakePushProvider();
    fakeProvider.failTokens.add(deadToken);
    await evaluateWeeklyDigestCandidates([{ userId, countryId }], fakeProvider);

    expect(fakeProvider.sent).toHaveLength(0);
    const remaining = await pool.query("SELECT token FROM push_tokens WHERE user_id = $1", [userId]);
    expect(remaining.rows).toHaveLength(0);

    const farFutureCutoff = new Date(Date.now() + 1000).toISOString();
    const stillDue = await listUsersDueForWeeklyDigest(farFutureCutoff);
    expect(stillDue.map((c) => c.userId)).not.toContain(userId);

    await app.close();
  });
});

describe("GET/PATCH /v1/me/notification-preferences - weeklyEventsDigest (Step 62)", () => {
  it("defaults to false and can be toggled independently", async () => {
    const app = buildApp();
    const { token } = await createRegularAccount(app, "route-default");

    const get = await app.inject({
      method: "GET",
      url: "/v1/me/notification-preferences",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(get.json().preferences.weeklyEventsDigest).toBe(false);

    const patch = await app.inject({
      method: "PATCH",
      url: "/v1/me/notification-preferences",
      payload: { weeklyEventsDigest: true },
      headers: { authorization: `Bearer ${token}` },
    });
    expect(patch.statusCode).toBe(200);
    expect(patch.json().preferences.weeklyEventsDigest).toBe(true);

    await app.close();
  });
});
