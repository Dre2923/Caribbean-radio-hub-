import { afterAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { pool } from "../src/db/pool.js";
import { ensureBootstrapAdminRole, setUserRole } from "../src/repositories/usersRepository.js";
import { parseAdminEmails } from "../src/config/env.js";

// One file-level afterAll, not one per describe: an afterAll nested inside
// an earlier describe block runs - and closes the pool - before a later
// sibling describe block's tests in the same file even start (the exact
// bug tests/emailOutbox.test.ts found and fixed earlier in this build).
afterAll(async () => {
  await pool.end();
});

describe("parseAdminEmails (ADMIN_EMAILS env var)", () => {
  it("returns an empty allowlist when unset", () => {
    expect(parseAdminEmails(undefined)).toEqual([]);
    expect(parseAdminEmails("")).toEqual([]);
  });

  it("splits a comma-separated list", () => {
    expect(parseAdminEmails("a@example.com,b@example.com")).toEqual([
      "a@example.com",
      "b@example.com",
    ]);
  });

  it("trims whitespace and lowercases each address", () => {
    expect(parseAdminEmails(" Admin@Example.com , Second@Example.com ")).toEqual([
      "admin@example.com",
      "second@example.com",
    ]);
  });

  it("drops empty entries from stray/trailing commas", () => {
    expect(parseAdminEmails("a@example.com,,b@example.com,")).toEqual([
      "a@example.com",
      "b@example.com",
    ]);
  });
});

// A single, fixed bootstrap-admin address configured in tests/setup.ts's
// ADMIN_EMAILS - proves the real registration/login routes actually
// promote a listed email to 'admin' end-to-end, not just the underlying
// repository function in isolation.
const BOOTSTRAP_ADMIN_EMAIL = "bootstrap-admin@example.com";
const BOOTSTRAP_ADMIN_PASSWORD = "bootstrap-admin-fixture-password-123";

// Registers a route that exists only for these tests - app.requireAdmin
// has no real production consumer yet (that's future Radio Catalog/Admin
// Dashboard work), so this is how its behavior gets exercised against a
// real app instance and a real database without inventing a speculative
// business endpoint ahead of when it's actually needed.
function buildAppWithAdminProbe() {
  const app = buildApp();
  app.get(
    "/v1/__test/admin-only",
    { preHandler: [app.authenticate, app.requireAdmin] },
    async () => ({ ok: true }),
  );
  return app;
}

async function registerAndLogin(
  app: ReturnType<typeof buildApp>,
  email: string,
  password: string,
): Promise<string> {
  await app.inject({
    method: "POST",
    url: "/v1/users",
    payload: { email, password, displayName: "Admin Role Test" },
  });
  const login = await app.inject({
    method: "POST",
    url: "/v1/auth/login",
    payload: { email, password },
  });
  expect(login.statusCode).toBe(200);
  return login.json().token as string;
}

describe("admin bootstrap via ADMIN_EMAILS", () => {
  it("promotes a registered account to admin end-to-end when its email is listed", async () => {
    const app = buildApp();

    const register = await app.inject({
      method: "POST",
      url: "/v1/users",
      payload: {
        email: BOOTSTRAP_ADMIN_EMAIL,
        password: BOOTSTRAP_ADMIN_PASSWORD,
        displayName: "Bootstrap Admin",
      },
    });
    // First local run against this database creates the account (201); a
    // repeat run against the same never-truncated-between-runs test
    // database finds it already registered (409) - both are fine, this
    // test only cares about the account's eventual role.
    expect([201, 409]).toContain(register.statusCode);
    if (register.statusCode === 201) {
      expect(register.json().user.role).toBe("admin");
    }

    const login = await app.inject({
      method: "POST",
      url: "/v1/auth/login",
      payload: { email: BOOTSTRAP_ADMIN_EMAIL, password: BOOTSTRAP_ADMIN_PASSWORD },
    });
    expect(login.statusCode).toBe(200);
    expect(login.json().user.role).toBe("admin");

    await app.close();
  });

  it("does not promote an unlisted email to admin", async () => {
    const app = buildApp();
    const email = `not-admin-${Date.now()}@example.com`;

    const register = await app.inject({
      method: "POST",
      url: "/v1/users",
      payload: { email, password: "regular-user-password-123", displayName: "Regular User" },
    });
    expect(register.statusCode).toBe(201);
    expect(register.json().user.role).toBe("user");

    await app.close();
  });

  it("strips a client-supplied role field on registration - role can never be self-assigned", async () => {
    const app = buildApp();
    const email = `role-injection-${Date.now()}@example.com`;

    const register = await app.inject({
      method: "POST",
      url: "/v1/users",
      payload: {
        email,
        password: "regular-user-password-123",
        displayName: "Role Injection Test",
        role: "admin",
      },
    });
    expect(register.statusCode).toBe(201);
    expect(register.json().user.role).toBe("user");

    await app.close();
  });
});

describe("ensureBootstrapAdminRole (repository function directly)", () => {
  it("is a no-op that returns 'user' for an account not on the allowlist", async () => {
    const app = buildApp();
    const email = `ensureadmin-unlisted-${Date.now()}@example.com`;
    const register = await app.inject({
      method: "POST",
      url: "/v1/users",
      payload: { email, password: "regular-user-password-123", displayName: "Ensure Admin Test" },
    });
    const userId = register.json().user.id as number;

    const role = await ensureBootstrapAdminRole(userId, email, []);
    expect(role).toBe("user");

    await app.close();
  });

  it("promotes exactly once and is idempotent on repeat calls", async () => {
    const app = buildApp();
    const email = `ensureadmin-listed-${Date.now()}@example.com`;
    const register = await app.inject({
      method: "POST",
      url: "/v1/users",
      payload: { email, password: "regular-user-password-123", displayName: "Ensure Admin Test" },
    });
    const userId = register.json().user.id as number;

    const firstCall = await ensureBootstrapAdminRole(userId, email, [email]);
    expect(firstCall).toBe("admin");
    const secondCall = await ensureBootstrapAdminRole(userId, email, [email]);
    expect(secondCall).toBe("admin");

    await app.close();
  });

  it("never demotes - removing an email from the allowlist doesn't touch an existing admin", async () => {
    const app = buildApp();
    const email = `ensureadmin-nodemote-${Date.now()}@example.com`;
    const register = await app.inject({
      method: "POST",
      url: "/v1/users",
      payload: { email, password: "regular-user-password-123", displayName: "Ensure Admin Test" },
    });
    const userId = register.json().user.id as number;

    await setUserRole(userId, "admin");
    const role = await ensureBootstrapAdminRole(userId, email, ["someone-else@example.com"]);
    expect(role).toBe("admin");

    await app.close();
  });
});

describe("app.requireAdmin", () => {
  it("rejects an unauthenticated request with 401 before ever reaching the role check", async () => {
    const app = buildAppWithAdminProbe();
    const response = await app.inject({ method: "GET", url: "/v1/__test/admin-only" });
    expect(response.statusCode).toBe(401);
    await app.close();
  });

  it("rejects an authenticated non-admin with 403", async () => {
    const app = buildAppWithAdminProbe();
    const email = `requireadmin-nonadmin-${Date.now()}@example.com`;
    const token = await registerAndLogin(app, email, "regular-user-password-123");

    const response = await app.inject({
      method: "GET",
      url: "/v1/__test/admin-only",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(403);

    await app.close();
  });

  it("allows an authenticated admin through", async () => {
    const app = buildAppWithAdminProbe();
    const email = `requireadmin-admin-${Date.now()}@example.com`;
    const token = await registerAndLogin(app, email, "regular-user-password-123");

    const decoded = app.jwt.decode<{ sub: number }>(token);
    if (!decoded) throw new Error("expected a decodable token");
    await setUserRole(decoded.sub, "admin");

    const response = await app.inject({
      method: "GET",
      url: "/v1/__test/admin-only",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true });

    await app.close();
  });

  it("takes effect on the very next request - no JWT caching of the role either direction", async () => {
    const app = buildAppWithAdminProbe();
    const email = `requireadmin-live-${Date.now()}@example.com`;
    const token = await registerAndLogin(app, email, "regular-user-password-123");
    const decoded = app.jwt.decode<{ sub: number }>(token);
    if (!decoded) throw new Error("expected a decodable token");

    // Starts as a regular user - blocked.
    const beforePromotion = await app.inject({
      method: "GET",
      url: "/v1/__test/admin-only",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(beforePromotion.statusCode).toBe(403);

    // Promoted without issuing a new token - the exact same token now
    // passes, proving the check isn't trusting anything embedded in the
    // JWT itself.
    await setUserRole(decoded.sub, "admin");
    const afterPromotion = await app.inject({
      method: "GET",
      url: "/v1/__test/admin-only",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(afterPromotion.statusCode).toBe(200);

    // Demoted, again without touching the token - access is revoked
    // immediately, not "whenever this token would next be reissued."
    await setUserRole(decoded.sub, "user");
    const afterDemotion = await app.inject({
      method: "GET",
      url: "/v1/__test/admin-only",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(afterDemotion.statusCode).toBe(403);

    await app.close();
  });
});
