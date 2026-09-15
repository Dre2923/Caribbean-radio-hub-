import { afterAll, afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { pool } from "../src/db/pool.js";

afterAll(async () => {
  await pool.end();
});

let createdUserIds: number[] = [];

afterEach(async () => {
  if (createdUserIds.length > 0) {
    await pool.query("DELETE FROM users WHERE id = ANY($1)", [createdUserIds]);
    createdUserIds = [];
  }
});

async function createRegularAccount(
  app: ReturnType<typeof buildApp>,
  label: string,
): Promise<{ token: string; userId: number }> {
  const email = `notifprefs-user-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
  const password = "notifprefs-user-password-123";
  const register = await app.inject({
    method: "POST",
    url: "/v1/users",
    payload: { email, password, displayName: "Notification Preferences User" },
  });
  const userId = register.json().user.id as number;
  createdUserIds.push(userId);
  const login = await app.inject({ method: "POST", url: "/v1/auth/login", payload: { email, password } });
  return { token: login.json().token as string, userId };
}

describe("Notification preferences", () => {
  it("requires authentication for both routes", async () => {
    const app = buildApp();
    const get = await app.inject({ method: "GET", url: "/v1/me/notification-preferences" });
    expect(get.statusCode).toBe(401);
    const patch = await app.inject({
      method: "PATCH",
      url: "/v1/me/notification-preferences",
      payload: { favoriteStationAvailabilityChanges: false },
    });
    expect(patch.statusCode).toBe(401);
    await app.close();
  });

  it("defaults to favoriteStationAvailabilityChanges: true for a never-customized account", async () => {
    const app = buildApp();
    const { token } = await createRegularAccount(app, "default");

    const response = await app.inject({
      method: "GET",
      url: "/v1/me/notification-preferences",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().preferences).toEqual({ favoriteStationAvailabilityChanges: true });

    await app.close();
  });

  it("updates and persists a preference, reflected on the next GET", async () => {
    const app = buildApp();
    const { token } = await createRegularAccount(app, "update");

    const patch = await app.inject({
      method: "PATCH",
      url: "/v1/me/notification-preferences",
      payload: { favoriteStationAvailabilityChanges: false },
      headers: { authorization: `Bearer ${token}` },
    });
    expect(patch.statusCode).toBe(200);
    expect(patch.json().preferences).toEqual({ favoriteStationAvailabilityChanges: false });

    const get = await app.inject({
      method: "GET",
      url: "/v1/me/notification-preferences",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(get.json().preferences).toEqual({ favoriteStationAvailabilityChanges: false });

    await app.close();
  });

  it("rejects an empty body - at least one field is required", async () => {
    const app = buildApp();
    const { token } = await createRegularAccount(app, "empty");

    const response = await app.inject({
      method: "PATCH",
      url: "/v1/me/notification-preferences",
      payload: {},
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(400);

    await app.close();
  });

  it("one account's preference change never affects another's default", async () => {
    const app = buildApp();
    const { token: tokenA } = await createRegularAccount(app, "isolation-a");
    const { token: tokenB } = await createRegularAccount(app, "isolation-b");

    await app.inject({
      method: "PATCH",
      url: "/v1/me/notification-preferences",
      payload: { favoriteStationAvailabilityChanges: false },
      headers: { authorization: `Bearer ${tokenA}` },
    });

    const getB = await app.inject({
      method: "GET",
      url: "/v1/me/notification-preferences",
      headers: { authorization: `Bearer ${tokenB}` },
    });
    expect(getB.json().preferences).toEqual({ favoriteStationAvailabilityChanges: true });

    await app.close();
  });
});
