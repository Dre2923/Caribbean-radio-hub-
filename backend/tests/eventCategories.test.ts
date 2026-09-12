import { afterAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { pool } from "../src/db/pool.js";

describe("GET /v1/event-categories", () => {
  afterAll(async () => {
    await pool.end();
  });

  it("lists the seeded event categories, publicly, sorted by name", async () => {
    const app = buildApp();
    const response = await app.inject({ method: "GET", url: "/v1/event-categories" });
    expect(response.statusCode).toBe(200);

    const categories = response.json().categories as Array<{ id: number; name: string }>;
    expect(categories.length).toBeGreaterThanOrEqual(12);
    expect(categories.map((c) => c.name)).toContain("Carnival");
    const names = categories.map((c) => c.name);
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));

    await app.close();
  });
});
