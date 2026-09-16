import { afterAll, afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { pool } from "../src/db/pool.js";
import { MAX_PUSH_TOKENS_PER_USER } from "../src/repositories/pushTokensRepository.js";

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
  const email = `push-user-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
  const password = "push-user-password-123";
  const register = await app.inject({
    method: "POST",
    url: "/v1/users",
    payload: { email, password, displayName: "Push Regular User" },
  });
  const userId = register.json().user.id as number;
  createdUserIds.push(userId);
  const login = await app.inject({ method: "POST", url: "/v1/auth/login", payload: { email, password } });
  return { token: login.json().token as string, userId };
}

function uniqueToken(label: string): string {
  return `fcm-token-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

describe("Push tokens", () => {
  it("requires authentication for every push-token route", async () => {
    const app = buildApp();
    const post = await app.inject({
      method: "POST",
      url: "/v1/me/push-tokens",
      payload: { token: "x", platform: "android" },
    });
    expect(post.statusCode).toBe(401);
    const list = await app.inject({ method: "GET", url: "/v1/me/push-tokens" });
    expect(list.statusCode).toBe(401);
    const del = await app.inject({ method: "DELETE", url: "/v1/me/push-tokens", payload: { token: "x" } });
    expect(del.statusCode).toBe(401);
    await app.close();
  });

  it("rejects an invalid platform", async () => {
    const app = buildApp();
    const { token } = await createRegularAccount(app, "bad-platform");
    const response = await app.inject({
      method: "POST",
      url: "/v1/me/push-tokens",
      payload: { token: uniqueToken("bad-platform"), platform: "macos" },
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(400);
    await app.close();
  });

  it("registers a token and lists it back", async () => {
    const app = buildApp();
    const { token } = await createRegularAccount(app, "register");
    const deviceToken = uniqueToken("register");

    const register = await app.inject({
      method: "POST",
      url: "/v1/me/push-tokens",
      payload: { token: deviceToken, platform: "ios" },
      headers: { authorization: `Bearer ${token}` },
    });
    expect(register.statusCode).toBe(204);

    const list = await app.inject({
      method: "GET",
      url: "/v1/me/push-tokens",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(list.statusCode).toBe(200);
    const body = list.json();
    expect(body.pushTokens).toHaveLength(1);
    expect(body.pushTokens[0].token).toBe(deviceToken);
    expect(body.pushTokens[0].platform).toBe("ios");
    expect(body.pagination.total).toBe(1);

    await app.close();
  });

  it("re-registering the same token for the same account is idempotent, not duplicated", async () => {
    const app = buildApp();
    const { token } = await createRegularAccount(app, "idempotent");
    const deviceToken = uniqueToken("idempotent");

    for (const platform of ["android", "android"]) {
      const response = await app.inject({
        method: "POST",
        url: "/v1/me/push-tokens",
        payload: { token: deviceToken, platform },
        headers: { authorization: `Bearer ${token}` },
      });
      expect(response.statusCode).toBe(204);
    }

    const list = await app.inject({
      method: "GET",
      url: "/v1/me/push-tokens",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(list.json().pushTokens).toHaveLength(1);

    await app.close();
  });

  it("re-registering an existing token under a different account transfers ownership", async () => {
    const app = buildApp();
    const { token: tokenA } = await createRegularAccount(app, "transfer-a");
    const { token: tokenB } = await createRegularAccount(app, "transfer-b");
    const deviceToken = uniqueToken("transfer");

    await app.inject({
      method: "POST",
      url: "/v1/me/push-tokens",
      payload: { token: deviceToken, platform: "android" },
      headers: { authorization: `Bearer ${tokenA}` },
    });

    // The same physical device now logs into a different account - the
    // client re-registers the same FCM token, which should move it, not
    // duplicate it or error.
    const reregister = await app.inject({
      method: "POST",
      url: "/v1/me/push-tokens",
      payload: { token: deviceToken, platform: "android" },
      headers: { authorization: `Bearer ${tokenB}` },
    });
    expect(reregister.statusCode).toBe(204);

    const listA = await app.inject({
      method: "GET",
      url: "/v1/me/push-tokens",
      headers: { authorization: `Bearer ${tokenA}` },
    });
    expect(listA.json().pushTokens).toHaveLength(0);

    const listB = await app.inject({
      method: "GET",
      url: "/v1/me/push-tokens",
      headers: { authorization: `Bearer ${tokenB}` },
    });
    expect(listB.json().pushTokens).toHaveLength(1);
    expect(listB.json().pushTokens[0].token).toBe(deviceToken);

    await app.close();
  });

  it("un-registers a token, and is idempotent", async () => {
    const app = buildApp();
    const { token } = await createRegularAccount(app, "unregister");
    const deviceToken = uniqueToken("unregister");

    await app.inject({
      method: "POST",
      url: "/v1/me/push-tokens",
      payload: { token: deviceToken, platform: "windows" },
      headers: { authorization: `Bearer ${token}` },
    });

    const del = await app.inject({
      method: "DELETE",
      url: "/v1/me/push-tokens",
      payload: { token: deviceToken },
      headers: { authorization: `Bearer ${token}` },
    });
    expect(del.statusCode).toBe(204);
    const delAgain = await app.inject({
      method: "DELETE",
      url: "/v1/me/push-tokens",
      payload: { token: deviceToken },
      headers: { authorization: `Bearer ${token}` },
    });
    expect(delAgain.statusCode).toBe(204);

    const list = await app.inject({
      method: "GET",
      url: "/v1/me/push-tokens",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(list.json().pushTokens).toHaveLength(0);

    await app.close();
  });

  it("one account cannot remove another account's token by guessing its value", async () => {
    const app = buildApp();
    const { token: tokenA } = await createRegularAccount(app, "guard-a");
    const { token: tokenB } = await createRegularAccount(app, "guard-b");
    const deviceToken = uniqueToken("guard");

    await app.inject({
      method: "POST",
      url: "/v1/me/push-tokens",
      payload: { token: deviceToken, platform: "ios" },
      headers: { authorization: `Bearer ${tokenA}` },
    });

    // B doesn't own this token, so its delete request is scoped away from
    // it entirely - a clean, idempotent 204 with no actual effect.
    const del = await app.inject({
      method: "DELETE",
      url: "/v1/me/push-tokens",
      payload: { token: deviceToken },
      headers: { authorization: `Bearer ${tokenB}` },
    });
    expect(del.statusCode).toBe(204);

    const listA = await app.inject({
      method: "GET",
      url: "/v1/me/push-tokens",
      headers: { authorization: `Bearer ${tokenA}` },
    });
    expect(listA.json().pushTokens).toHaveLength(1);

    await app.close();
  });
});

describe("Push tokens - per-account cap (Step 58, OWASP API4)", () => {
  it("rejects a genuinely new token once the account is at the cap, with 409", async () => {
    const app = buildApp();
    const { token } = await createRegularAccount(app, "cap-limit");

    for (let i = 0; i < MAX_PUSH_TOKENS_PER_USER; i++) {
      const response = await app.inject({
        method: "POST",
        url: "/v1/me/push-tokens",
        payload: { token: uniqueToken(`cap-limit-${i}`), platform: "android" },
        headers: { authorization: `Bearer ${token}` },
      });
      expect(response.statusCode).toBe(204);
    }

    const overCap = await app.inject({
      method: "POST",
      url: "/v1/me/push-tokens",
      payload: { token: uniqueToken("cap-limit-over"), platform: "android" },
      headers: { authorization: `Bearer ${token}` },
    });
    expect(overCap.statusCode).toBe(409);
    expect(overCap.json().message).toContain(String(MAX_PUSH_TOKENS_PER_USER));

    const list = await app.inject({
      method: "GET",
      url: "/v1/me/push-tokens",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(list.json().pagination.total).toBe(MAX_PUSH_TOKENS_PER_USER);

    await app.close();
  });

  it("still allows re-registering an already-owned token once at the cap - a refresh is never new growth", async () => {
    const app = buildApp();
    const { token } = await createRegularAccount(app, "cap-refresh");
    const firstToken = uniqueToken("cap-refresh-0");

    for (let i = 0; i < MAX_PUSH_TOKENS_PER_USER; i++) {
      const response = await app.inject({
        method: "POST",
        url: "/v1/me/push-tokens",
        payload: { token: i === 0 ? firstToken : uniqueToken(`cap-refresh-${i}`), platform: "ios" },
        headers: { authorization: `Bearer ${token}` },
      });
      expect(response.statusCode).toBe(204);
    }

    // Re-registering the very first token (already owned) must succeed
    // even though the account is exactly at the cap.
    const refresh = await app.inject({
      method: "POST",
      url: "/v1/me/push-tokens",
      payload: { token: firstToken, platform: "ios" },
      headers: { authorization: `Bearer ${token}` },
    });
    expect(refresh.statusCode).toBe(204);

    const list = await app.inject({
      method: "GET",
      url: "/v1/me/push-tokens",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(list.json().pagination.total).toBe(MAX_PUSH_TOKENS_PER_USER);

    await app.close();
  });

  it("frees up a slot after un-registering a token, once at the cap", async () => {
    const app = buildApp();
    const { token } = await createRegularAccount(app, "cap-free-slot");
    const tokens: string[] = [];

    for (let i = 0; i < MAX_PUSH_TOKENS_PER_USER; i++) {
      const deviceToken = uniqueToken(`cap-free-slot-${i}`);
      tokens.push(deviceToken);
      const response = await app.inject({
        method: "POST",
        url: "/v1/me/push-tokens",
        payload: { token: deviceToken, platform: "windows" },
        headers: { authorization: `Bearer ${token}` },
      });
      expect(response.statusCode).toBe(204);
    }

    await app.inject({
      method: "DELETE",
      url: "/v1/me/push-tokens",
      payload: { token: tokens[0] },
      headers: { authorization: `Bearer ${token}` },
    });

    const afterFreeingASlot = await app.inject({
      method: "POST",
      url: "/v1/me/push-tokens",
      payload: { token: uniqueToken("cap-free-slot-new"), platform: "windows" },
      headers: { authorization: `Bearer ${token}` },
    });
    expect(afterFreeingASlot.statusCode).toBe(204);

    await app.close();
  });
});
