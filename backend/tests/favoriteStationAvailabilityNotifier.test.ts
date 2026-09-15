import { afterAll, afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { pool } from "../src/db/pool.js";
import { setUserRole } from "../src/repositories/usersRepository.js";
import { notifyFavoriteStationAvailabilityChange } from "../src/notifications/favoriteStationAvailabilityNotifier.js";
import { InvalidPushTokenError, type PushMessage, type PushProvider } from "../src/notifications/types.js";

afterAll(async () => {
  await pool.end();
});

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

// Records every message it was asked to send, and can be configured to
// reject specific tokens with InvalidPushTokenError - real enough to
// exercise the notifier's own fan-out, error-isolation, and stale-token
// cleanup logic without ever touching a real network call, the identical
// fake-provider-via-dependency-injection approach already used throughout
// this codebase's own tests (e.g. FcmPushProvider's injected FetchLike).
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
  const email = `notif-admin-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
  const password = "notif-admin-password-123";
  const register = await app.inject({
    method: "POST",
    url: "/v1/users",
    payload: { email, password, displayName: "Notifier Admin" },
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
  const email = `notif-user-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
  const password = "notif-user-password-123";
  const register = await app.inject({
    method: "POST",
    url: "/v1/users",
    payload: { email, password, displayName: "Notifier Regular User" },
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

async function favoriteStation(app: ReturnType<typeof buildApp>, token: string, stationId: number) {
  const response = await app.inject({
    method: "PUT",
    url: `/v1/me/favorites/stations/${stationId}`,
    headers: { authorization: `Bearer ${token}` },
  });
  expect(response.statusCode).toBe(204);
}

async function registerPushToken(
  app: ReturnType<typeof buildApp>,
  token: string,
  deviceToken: string,
) {
  const response = await app.inject({
    method: "POST",
    url: "/v1/me/push-tokens",
    payload: { token: deviceToken, platform: "android" },
    headers: { authorization: `Bearer ${token}` },
  });
  expect(response.statusCode).toBe(204);
}

describe("notifyFavoriteStationAvailabilityChange", () => {
  it("sends to every favoriter's registered device by default", async () => {
    const app = buildApp();
    const countryId = await getIsolatedCountryId(app);
    const adminToken = await createAdminToken(app, "send");
    const { token } = await createRegularAccount(app, "send");
    const marker = `Notifier Station ${Date.now()}${Math.random().toString(36).slice(2)}`;
    const stationId = await createStation(app, { countryId, adminToken, name: marker });
    await favoriteStation(app, token, stationId);
    const deviceToken = `device-${Date.now()}`;
    await registerPushToken(app, token, deviceToken);

    const fakeProvider = new FakePushProvider();
    await notifyFavoriteStationAvailabilityChange(stationId, marker, false, fakeProvider);

    expect(fakeProvider.sent).toHaveLength(1);
    expect(fakeProvider.sent[0].token).toBe(deviceToken);
    expect(fakeProvider.sent[0].title).toMatch(/unavailable/i);
    expect(fakeProvider.sent[0].body).toContain(marker);

    await app.close();
  });

  it("sends a 'back' message when isNowActive is true", async () => {
    const app = buildApp();
    const countryId = await getIsolatedCountryId(app);
    const adminToken = await createAdminToken(app, "back");
    const { token } = await createRegularAccount(app, "back");
    const marker = `Notifier Back ${Date.now()}`;
    const stationId = await createStation(app, { countryId, adminToken, name: marker });
    await favoriteStation(app, token, stationId);
    await registerPushToken(app, token, `device-back-${Date.now()}`);

    const fakeProvider = new FakePushProvider();
    await notifyFavoriteStationAvailabilityChange(stationId, marker, true, fakeProvider);

    expect(fakeProvider.sent).toHaveLength(1);
    expect(fakeProvider.sent[0].title).toMatch(/back/i);

    await app.close();
  });

  it("skips a user who opted out of this notification type", async () => {
    const app = buildApp();
    const countryId = await getIsolatedCountryId(app);
    const adminToken = await createAdminToken(app, "opt-out");
    const { token } = await createRegularAccount(app, "opt-out");
    const stationId = await createStation(app, { countryId, adminToken, name: `Notifier OptOut ${Date.now()}` });
    await favoriteStation(app, token, stationId);
    await registerPushToken(app, token, `device-optout-${Date.now()}`);

    const patch = await app.inject({
      method: "PATCH",
      url: "/v1/me/notification-preferences",
      payload: { favoriteStationAvailabilityChanges: false },
      headers: { authorization: `Bearer ${token}` },
    });
    expect(patch.statusCode).toBe(200);

    const fakeProvider = new FakePushProvider();
    await notifyFavoriteStationAvailabilityChange(stationId, "Notifier OptOut", false, fakeProvider);

    expect(fakeProvider.sent).toHaveLength(0);

    await app.close();
  });

  it("does nothing (no error) when a station has no favoriters", async () => {
    const app = buildApp();
    const countryId = await getIsolatedCountryId(app);
    const adminToken = await createAdminToken(app, "no-favoriters");
    const stationId = await createStation(app, {
      countryId,
      adminToken,
      name: `Notifier NoFavoriters ${Date.now()}`,
    });

    const fakeProvider = new FakePushProvider();
    await expect(
      notifyFavoriteStationAvailabilityChange(stationId, "x", false, fakeProvider),
    ).resolves.toBeUndefined();
    expect(fakeProvider.sent).toHaveLength(0);

    await app.close();
  });

  it("isolates one dead token's failure - other favoriters still get notified, and the dead token is removed", async () => {
    const app = buildApp();
    const countryId = await getIsolatedCountryId(app);
    const adminToken = await createAdminToken(app, "isolate");
    const { token: tokenA, userId: userIdA } = await createRegularAccount(app, "isolate-a");
    const { token: tokenB } = await createRegularAccount(app, "isolate-b");
    const stationId = await createStation(app, { countryId, adminToken, name: `Notifier Isolate ${Date.now()}` });
    await favoriteStation(app, tokenA, stationId);
    await favoriteStation(app, tokenB, stationId);
    const deadToken = `device-dead-${Date.now()}`;
    const liveToken = `device-live-${Date.now()}`;
    await registerPushToken(app, tokenA, deadToken);
    await registerPushToken(app, tokenB, liveToken);

    const fakeProvider = new FakePushProvider();
    fakeProvider.failTokens.add(deadToken);

    await notifyFavoriteStationAvailabilityChange(stationId, "Notifier Isolate", false, fakeProvider);

    expect(fakeProvider.sent).toHaveLength(1);
    expect(fakeProvider.sent[0].token).toBe(liveToken);

    // The dead token's own registration was cleaned up as a side effect.
    const remaining = await pool.query("SELECT token FROM push_tokens WHERE user_id = $1", [userIdA]);
    expect(remaining.rows).toHaveLength(0);

    await app.close();
  });
});

describe("PATCH /v1/stations/:id wiring (Step 54's real trigger)", () => {
  it("deactivating a favorited station via the real route still returns 200 with the default provider", async () => {
    const app = buildApp();
    const countryId = await getIsolatedCountryId(app);
    const adminToken = await createAdminToken(app, "route-wiring");
    const { token } = await createRegularAccount(app, "route-wiring");
    const stationId = await createStation(app, {
      countryId,
      adminToken,
      name: `Notifier RouteWiring ${Date.now()}`,
    });
    await favoriteStation(app, token, stationId);
    await registerPushToken(app, token, `device-route-wiring-${Date.now()}`);

    // No FCM_SERVICE_ACCOUNT_JSON is configured in this test environment,
    // so the route's own default createPushProvider() resolves to
    // ConsoleNotificationProvider - this proves the wiring in
    // routes/stations.ts (fetch-before, compare, notify-after) doesn't
    // throw or block the response, not the FCM send path itself (covered
    // separately by tests/pushNotifications.test.ts's mocked-fetch unit
    // tests).
    const patch = await app.inject({
      method: "PATCH",
      url: `/v1/stations/${stationId}`,
      payload: { isActive: false },
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(patch.statusCode).toBe(200);
    expect(patch.json().station.isActive).toBe(false);

    // A redundant PATCH repeating isActive: false must not error either -
    // the "only notify on a genuine flip" guard also just means "do
    // nothing," never "reject."
    const patchAgain = await app.inject({
      method: "PATCH",
      url: `/v1/stations/${stationId}`,
      payload: { isActive: false },
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(patchAgain.statusCode).toBe(200);

    await app.close();
  });
});
