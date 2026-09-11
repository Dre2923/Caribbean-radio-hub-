import { afterAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { pool } from "../src/db/pool.js";

describe("GET /v1/genres and /v1/languages", () => {
  afterAll(async () => {
    await pool.end();
  });

  it("lists the seeded genres, publicly, sorted by name", async () => {
    const app = buildApp();
    const response = await app.inject({ method: "GET", url: "/v1/genres" });
    expect(response.statusCode).toBe(200);

    const genres = response.json().genres as Array<{ id: number; name: string }>;
    expect(genres.length).toBeGreaterThanOrEqual(12);
    expect(genres.map((g) => g.name)).toContain("Reggae");
    const names = genres.map((g) => g.name);
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));

    await app.close();
  });

  it("lists the seeded languages, publicly, sorted by name", async () => {
    const app = buildApp();
    const response = await app.inject({ method: "GET", url: "/v1/languages" });
    expect(response.statusCode).toBe(200);

    const languages = response.json().languages as Array<{ id: number; code: string; name: string }>;
    expect(languages.length).toBeGreaterThanOrEqual(4);
    expect(languages.map((l) => l.code)).toContain("en");
    expect(languages.map((l) => l.code)).toContain("fr-CR");

    await app.close();
  });
});
