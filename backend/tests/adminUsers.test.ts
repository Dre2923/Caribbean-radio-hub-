import { afterAll, afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { pool } from "../src/db/pool.js";
import { findUserById, setUserRole } from "../src/repositories/usersRepository.js";

afterAll(async () => {
  await pool.end();
});

// GET /v1/admin/users has no country/isolated-fixture concept to scope a
// test to (unlike stations/events) and the shared test database accumulates
// real user accounts across the full history of local runs and every other
// test file (adminRole.test.ts's fixed bootstrap admin included) - so every
// list/search assertion here uses a unique marker embedded in each test's
// own email addresses (the same "unique marker + q= filter scoping"
// mitigation already established for tests/stationRanking.test.ts) rather
// than asserting on the listing's unfiltered total. Every user this file
// creates is still hard-deleted in afterEach as a second, independent layer
// of hygiene - the same two-layer protection as tests/events.test.ts.
let createdUserIds: number[] = [];

afterEach(async () => {
  if (createdUserIds.length > 0) {
    await pool.query("DELETE FROM users WHERE id = ANY($1)", [createdUserIds]);
    createdUserIds = [];
  }
});

async function registerUser(
  app: ReturnType<typeof buildApp>,
  marker: string,
  label: string,
): Promise<{ token: string; userId: number; email: string }> {
  const email = `adminusers-${marker}-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
  const password = "admin-users-test-password-123";
  const register = await app.inject({
    method: "POST",
    url: "/v1/users",
    payload: { email, password, displayName: `Admin Users Test ${label}` },
  });
  const userId = register.json().user.id as number;
  createdUserIds.push(userId);
  const login = await app.inject({ method: "POST", url: "/v1/auth/login", payload: { email, password } });
  return { token: login.json().token as string, userId, email };
}

// A separate helper (rather than an optional param on registerUser) so
// every call site that doesn't care about displayName content keeps using
// the plain default - this one exists specifically to embed a marker in
// displayName instead of email, the only way to prove the search's
// "OR display_name ILIKE" branch actually works and isn't just always
// matching via the email half of the OR.
async function registerUserWithDisplayName(
  app: ReturnType<typeof buildApp>,
  displayName: string,
): Promise<{ token: string; userId: number; email: string }> {
  const email = `adminusers-displayname-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
  const password = "admin-users-test-password-123";
  const register = await app.inject({
    method: "POST",
    url: "/v1/users",
    payload: { email, password, displayName },
  });
  const userId = register.json().user.id as number;
  createdUserIds.push(userId);
  const login = await app.inject({ method: "POST", url: "/v1/auth/login", payload: { email, password } });
  return { token: login.json().token as string, userId, email };
}

async function registerAdmin(
  app: ReturnType<typeof buildApp>,
  marker: string,
  label: string,
): Promise<{ token: string; userId: number; email: string }> {
  const account = await registerUser(app, marker, label);
  await setUserRole(account.userId, "admin");
  // setUserRole doesn't reissue a token - the account's existing token is
  // still valid (role isn't embedded in the JWT, see app.ts's
  // requireAdmin), it just now resolves to "admin" on the next lookup.
  return account;
}

describe("GET /v1/admin/users", () => {
  it("requires authentication", async () => {
    const app = buildApp();
    const response = await app.inject({ method: "GET", url: "/v1/admin/users" });
    expect(response.statusCode).toBe(401);
    await app.close();
  });

  it("requires an admin account", async () => {
    const app = buildApp();
    const regular = await registerUser(app, "gate", "regular");

    const response = await app.inject({
      method: "GET",
      url: "/v1/admin/users",
      headers: { authorization: `Bearer ${regular.token}` },
    });
    expect(response.statusCode).toBe(403);
    await app.close();
  });

  it("q= narrows to accounts matching the marker in email or displayName", async () => {
    const app = buildApp();
    const admin = await registerAdmin(app, "search", "admin");
    const marker = `search-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const alice = await registerUser(app, marker, "alice");
    const bob = await registerUser(app, marker, "bob");

    const response = await app.inject({
      method: "GET",
      url: `/v1/admin/users?q=${marker}`,
      headers: { authorization: `Bearer ${admin.token}` },
    });
    expect(response.statusCode).toBe(200);
    const ids = (response.json().users as Array<{ id: number }>).map((user) => user.id);
    expect(new Set(ids)).toEqual(new Set([alice.userId, bob.userId]));
    expect(response.json().pagination.total).toBe(2);

    await app.close();
  });

  it("q= also matches against displayName, not only email", async () => {
    const app = buildApp();
    const admin = await registerAdmin(app, "search-name", "admin");
    const marker = `NameMarker${Date.now()}${Math.random().toString(36).slice(2)}`;
    // The marker deliberately appears ONLY in displayName, not email - this
    // is what actually proves the "OR display_name ILIKE" half of the
    // search condition works, as opposed to every match happening to go
    // through the email half.
    const target = await registerUserWithDisplayName(app, `Searchable ${marker} Person`);

    const response = await app.inject({
      method: "GET",
      url: `/v1/admin/users?q=${marker}`,
      headers: { authorization: `Bearer ${admin.token}` },
    });
    expect(response.statusCode).toBe(200);
    const ids = (response.json().users as Array<{ id: number }>).map((user) => user.id);
    expect(ids).toEqual([target.userId]);

    await app.close();
  });

  it("role= narrows to exactly that role", async () => {
    const app = buildApp();
    const admin = await registerAdmin(app, "role-filter", "admin");
    const marker = `role-filter-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const regular = await registerUser(app, marker, "regular");

    const response = await app.inject({
      method: "GET",
      url: `/v1/admin/users?q=${marker}&role=user`,
      headers: { authorization: `Bearer ${admin.token}` },
    });
    expect(response.statusCode).toBe(200);
    const ids = (response.json().users as Array<{ id: number }>).map((user) => user.id);
    expect(ids).toEqual([regular.userId]);

    const adminOnlyResponse = await app.inject({
      method: "GET",
      url: `/v1/admin/users?q=${marker}&role=admin`,
      headers: { authorization: `Bearer ${admin.token}` },
    });
    expect(adminOnlyResponse.json().users).toEqual([]);

    await app.close();
  });
});

describe("GET /v1/admin/users/:id", () => {
  it("requires an admin account", async () => {
    const app = buildApp();
    const regular = await registerUser(app, "get-gate", "regular");

    const response = await app.inject({
      method: "GET",
      url: `/v1/admin/users/${regular.userId}`,
      headers: { authorization: `Bearer ${regular.token}` },
    });
    expect(response.statusCode).toBe(403);
    await app.close();
  });

  it("returns the full user record, including the role-change audit trail", async () => {
    const app = buildApp();
    const admin = await registerAdmin(app, "get-detail", "admin");
    const target = await registerUser(app, "get-detail", "target");

    const response = await app.inject({
      method: "GET",
      url: `/v1/admin/users/${target.userId}`,
      headers: { authorization: `Bearer ${admin.token}` },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().user.id).toBe(target.userId);
    expect(response.json().user.email).toBe(target.email);
    expect(response.json().user.role).toBe("user");
    // Never explicitly changed since registration (this account wasn't on
    // the ADMIN_EMAILS bootstrap allowlist and no admin has acted on it).
    expect(response.json().user.roleChangedAt).toBeNull();
    expect(response.json().user.roleChangedByUserId).toBeNull();

    await app.close();
  });

  it("404s for a nonexistent user id", async () => {
    const app = buildApp();
    const admin = await registerAdmin(app, "get-404", "admin");

    const response = await app.inject({
      method: "GET",
      url: "/v1/admin/users/999999999",
      headers: { authorization: `Bearer ${admin.token}` },
    });
    expect(response.statusCode).toBe(404);
    await app.close();
  });
});

describe("PATCH /v1/admin/users/:id (role management)", () => {
  it("requires an admin account", async () => {
    const app = buildApp();
    const regular = await registerUser(app, "patch-gate", "regular");
    const target = await registerUser(app, "patch-gate", "target");

    const response = await app.inject({
      method: "PATCH",
      url: `/v1/admin/users/${target.userId}`,
      payload: { role: "admin" },
      headers: { authorization: `Bearer ${regular.token}` },
    });
    expect(response.statusCode).toBe(403);
    await app.close();
  });

  it("promotes a regular user to admin and records who did it and when", async () => {
    const app = buildApp();
    const admin = await registerAdmin(app, "promote", "admin");
    const target = await registerUser(app, "promote", "target");

    const response = await app.inject({
      method: "PATCH",
      url: `/v1/admin/users/${target.userId}`,
      payload: { role: "admin" },
      headers: { authorization: `Bearer ${admin.token}` },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().user.role).toBe("admin");
    expect(response.json().user.roleChangedByUserId).toBe(admin.userId);
    expect(response.json().user.roleChangedAt).not.toBeNull();

    // The promoted account can now reach an admin-only route with its
    // existing token - role isn't embedded in the JWT (see app.ts), so no
    // re-login is needed for the promotion to take effect.
    const check = await app.inject({
      method: "GET",
      url: "/v1/admin/users",
      headers: { authorization: `Bearer ${target.token}` },
    });
    expect(check.statusCode).toBe(200);

    await app.close();
  });

  it("demotes an admin back to a regular user when other admins remain", async () => {
    const app = buildApp();
    const admin = await registerAdmin(app, "demote", "acting-admin");
    const target = await registerAdmin(app, "demote", "target-admin");

    const response = await app.inject({
      method: "PATCH",
      url: `/v1/admin/users/${target.userId}`,
      payload: { role: "user" },
      headers: { authorization: `Bearer ${admin.token}` },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().user.role).toBe("user");
    expect(response.json().user.roleChangedByUserId).toBe(admin.userId);

    await app.close();
  });

  it("rejects an invalid role value", async () => {
    const app = buildApp();
    const admin = await registerAdmin(app, "invalid-role", "admin");
    const target = await registerUser(app, "invalid-role", "target");

    const response = await app.inject({
      method: "PATCH",
      url: `/v1/admin/users/${target.userId}`,
      payload: { role: "superadmin" },
      headers: { authorization: `Bearer ${admin.token}` },
    });
    expect(response.statusCode).toBe(400);
    await app.close();
  });

  it("404s for a nonexistent user id", async () => {
    const app = buildApp();
    const admin = await registerAdmin(app, "patch-404", "admin");

    const response = await app.inject({
      method: "PATCH",
      url: "/v1/admin/users/999999999",
      payload: { role: "admin" },
      headers: { authorization: `Bearer ${admin.token}` },
    });
    expect(response.statusCode).toBe(404);
    await app.close();
  });

  it("rejects demoting the last remaining admin, including an admin demoting themselves (409)", async () => {
    const app = buildApp();
    const soleAdmin = await registerAdmin(app, "last-admin", "sole");

    // This shared test database accumulates real admin accounts across the
    // full history of local runs (adminRole.test.ts's fixed bootstrap
    // admin included) - "exactly one admin exists" isn't naturally true
    // here, so every OTHER current admin is temporarily demoted for the
    // length of this one test and unconditionally restored in `finally`,
    // regardless of outcome. Safe because vitest runs this suite with
    // fileParallelism:false and no test-level concurrency (see
    // vitest.config.ts), so no other test can observe this window.
    const otherAdmins = await pool.query<{ id: number }>(
      "SELECT id FROM users WHERE role = 'admin' AND id <> $1",
      [soleAdmin.userId],
    );
    const otherAdminIds = otherAdmins.rows.map((row) => row.id);

    try {
      if (otherAdminIds.length > 0) {
        await pool.query("UPDATE users SET role = 'user' WHERE id = ANY($1)", [otherAdminIds]);
      }

      const response = await app.inject({
        method: "PATCH",
        url: `/v1/admin/users/${soleAdmin.userId}`,
        payload: { role: "user" },
        headers: { authorization: `Bearer ${soleAdmin.token}` },
      });
      expect(response.statusCode).toBe(409);

      const stillAdmin = await findUserById(soleAdmin.userId);
      expect(stillAdmin?.role).toBe("admin");
    } finally {
      if (otherAdminIds.length > 0) {
        await pool.query("UPDATE users SET role = 'admin' WHERE id = ANY($1)", [otherAdminIds]);
      }
    }

    await app.close();
  });
});

// Step 55 (User Features bucket closing pass): see tests/stations.test.ts's
// own identical describe block for the full finding - every id-shaped
// integer field across this API, this file's admin :id routes included,
// enforced only `minimum: 1` with no upper bound, so an out-of-int4-range
// value reached Postgres and raised a raw, unhandled 500 instead of a
// clean 400. Fixed with the shared, bounded `idSchema`.
describe("Integer id upper bound (Step 55)", () => {
  it("rejects an out-of-int4-range admin :id path param with 400, not a raw database error", async () => {
    const app = buildApp();
    const admin = await registerAdmin(app, "id-bound", "admin");
    createdUserIds.push(admin.userId);

    const response = await app.inject({
      method: "GET",
      url: "/v1/admin/users/99999999999999999999",
      headers: { authorization: `Bearer ${admin.token}` },
    });
    expect(response.statusCode).toBe(400);

    await app.close();
  });
});
