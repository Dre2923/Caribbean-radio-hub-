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

// Step 55: the User Features bucket's (51-54) closing adversarial
// hardening pass, the same "the closing step reviews and hardens
// everything the bucket built" shape as Steps 18/23/30/38's own bucket
// closers.
//
// This block started life testing the opposite expectation - that an
// unrecognized field like `role` should make the whole PATCH fail with
// 400, on the assumption that `additionalProperties: false` always means
// "reject". Live-probing against a running server (before writing the
// fix this test now encodes) revealed that isn't what happens: Fastify's
// ajv compiler defaults to `removeAdditional: true`
// (@fastify/ajv-compiler's own default-ajv-options.js), and per ajv's own
// documented semantics that makes an explicit `additionalProperties:
// false` silently delete the unrecognized field and let validation pass,
// rather than fail it. Changing that default was the obvious "fix" - and
// was reverted after it broke `tests/adminRole.test.ts`'s own
// pre-existing "strips a client-supplied role field on registration - role
// can never be self-assigned" test (plus two equivalent ones in
// stations.test.ts/events.test.ts): this codebase already relies on that
// exact silent-strip behavior, deliberately and by design, as its
// mass-assignment defense - dropping a forbidden field and proceeding
// with the request rather than rejecting it outright. So the real finding
// here isn't a bug at all: it's that this endpoint already benefits from
// the same protection, previously unverified for this specific route.
describe("Notification preferences - adversarial hardening (Step 55)", () => {
  it("silently ignores an unrecognized field (mass-assignment defense) rather than applying or erroring on it", async () => {
    const app = buildApp();
    const { token } = await createRegularAccount(app, "mass-assignment");

    const unknownFieldAlone = await app.inject({
      method: "PATCH",
      url: "/v1/me/notification-preferences",
      payload: { role: "admin" },
      headers: { authorization: `Bearer ${token}` },
    });
    // No recognized field was present, but the unrecognized one is
    // dropped rather than rejected - the identical shape as registration
    // silently stripping a client-supplied `role`, confirmed as this
    // codebase's own deliberate convention, not asserted from scratch here.
    expect(unknownFieldAlone.statusCode).toBe(200);
    expect(unknownFieldAlone.json().preferences).toEqual({
      favoriteStationAvailabilityChanges: true,
    });

    const mixedFields = await app.inject({
      method: "PATCH",
      url: "/v1/me/notification-preferences",
      payload: { favoriteStationAvailabilityChanges: false, role: "admin" },
      headers: { authorization: `Bearer ${token}` },
    });
    // The one recognized field alongside it still applies normally - only
    // the unrecognized one is silently discarded.
    expect(mixedFields.statusCode).toBe(200);
    expect(mixedFields.json().preferences).toEqual({
      favoriteStationAvailabilityChanges: false,
    });

    await app.close();
  });
});
