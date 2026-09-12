import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";

// Schema-level validation runs before the handler, so these never touch the
// database or need an admin token - they exercise createStationBodySchema/
// updateStationBodySchema in isolation, the same split as
// tests/users.validation.test.ts vs. the real-DB tests/stations.test.ts.
describe("POST /v1/stations validation", () => {
  it("rejects a missing countryId, name, or streamUrl", async () => {
    const app = buildApp();
    const response = await app.inject({
      method: "POST",
      url: "/v1/stations",
      payload: {},
    });
    // Schema validation runs in Fastify's own preValidation phase, before
    // any preHandler (including app.authenticate) - so a malformed body
    // is rejected as 400, not 401, even with no token at all.
    expect(response.statusCode).toBe(400);
    await app.close();
  });

  it("rejects a non-HTTPS streamUrl", async () => {
    const app = buildApp();
    const response = await app.inject({
      method: "POST",
      url: "/v1/stations",
      payload: { countryId: 1, name: "Test Station", streamUrl: "http://example.com/stream" },
    });
    expect(response.statusCode).toBe(400);
    await app.close();
  });

  it("rejects a malformed streamUrl", async () => {
    const app = buildApp();
    const response = await app.inject({
      method: "POST",
      url: "/v1/stations",
      payload: { countryId: 1, name: "Test Station", streamUrl: "not-a-url" },
    });
    expect(response.statusCode).toBe(400);
    await app.close();
  });

  it("rejects a non-HTTPS websiteUrl", async () => {
    const app = buildApp();
    const response = await app.inject({
      method: "POST",
      url: "/v1/stations",
      payload: {
        countryId: 1,
        name: "Test Station",
        streamUrl: "https://example.com/stream",
        websiteUrl: "http://example.com",
      },
    });
    expect(response.statusCode).toBe(400);
    await app.close();
  });

  it("rejects a non-HTTPS logoUrl", async () => {
    const app = buildApp();
    const response = await app.inject({
      method: "POST",
      url: "/v1/stations",
      payload: {
        countryId: 1,
        name: "Test Station",
        streamUrl: "https://example.com/stream",
        logoUrl: "http://example.com/logo.png",
      },
    });
    expect(response.statusCode).toBe(400);
    await app.close();
  });

  it("rejects a malformed logoUrl", async () => {
    const app = buildApp();
    const response = await app.inject({
      method: "POST",
      url: "/v1/stations",
      payload: {
        countryId: 1,
        name: "Test Station",
        streamUrl: "https://example.com/stream",
        logoUrl: "not-a-url",
      },
    });
    expect(response.statusCode).toBe(400);
    await app.close();
  });

  it("rejects a non-integer countryId", async () => {
    const app = buildApp();
    const response = await app.inject({
      method: "POST",
      url: "/v1/stations",
      payload: { countryId: "not-a-number", name: "Test Station", streamUrl: "https://example.com/stream" },
    });
    expect(response.statusCode).toBe(400);
    await app.close();
  });

  it("rejects a name longer than the column limit", async () => {
    const app = buildApp();
    const response = await app.inject({
      method: "POST",
      url: "/v1/stations",
      payload: {
        countryId: 1,
        name: "a".repeat(201),
        streamUrl: "https://example.com/stream",
      },
    });
    expect(response.statusCode).toBe(400);
    await app.close();
  });

  // An unknown field isn't rejected by additionalProperties: false here -
  // Fastify's AJV compiler runs with removeAdditional: true by default, so
  // it's silently stripped before validation even runs (same documented
  // behavior as POST /v1/users - see users.ts). Proven with a real admin
  // token in tests/stations.test.ts rather than asserted as a 400 here.
});

describe("PATCH /v1/stations/:id validation", () => {
  it("rejects an empty body", async () => {
    const app = buildApp();
    const response = await app.inject({
      method: "PATCH",
      url: "/v1/stations/1",
      payload: {},
    });
    expect(response.statusCode).toBe(400);
    await app.close();
  });

  it("rejects a non-HTTPS streamUrl", async () => {
    const app = buildApp();
    const response = await app.inject({
      method: "PATCH",
      url: "/v1/stations/1",
      payload: { streamUrl: "http://example.com/stream" },
    });
    expect(response.statusCode).toBe(400);
    await app.close();
  });

  it("rejects a non-boolean isActive", async () => {
    const app = buildApp();
    const response = await app.inject({
      method: "PATCH",
      url: "/v1/stations/1",
      payload: { isActive: "yes" },
    });
    expect(response.statusCode).toBe(400);
    await app.close();
  });

  it("rejects a non-HTTPS logoUrl", async () => {
    const app = buildApp();
    const response = await app.inject({
      method: "PATCH",
      url: "/v1/stations/1",
      payload: { logoUrl: "http://example.com/logo.png" },
    });
    expect(response.statusCode).toBe(400);
    await app.close();
  });
});

describe("GET /v1/stations validation", () => {
  it("rejects a non-integer countryId query param", async () => {
    const app = buildApp();
    const response = await app.inject({ method: "GET", url: "/v1/stations?countryId=abc" });
    expect(response.statusCode).toBe(400);
    await app.close();
  });

  it("rejects a non-integer genreId or languageId", async () => {
    const app = buildApp();
    const badGenre = await app.inject({ method: "GET", url: "/v1/stations?genreId=abc" });
    expect(badGenre.statusCode).toBe(400);

    const badLanguage = await app.inject({ method: "GET", url: "/v1/stations?languageId=abc" });
    expect(badLanguage.statusCode).toBe(400);
    await app.close();
  });

  it("rejects a limit of 0, a negative limit, or a limit over the maximum", async () => {
    const app = buildApp();
    const zero = await app.inject({ method: "GET", url: "/v1/stations?limit=0" });
    expect(zero.statusCode).toBe(400);

    const negative = await app.inject({ method: "GET", url: "/v1/stations?limit=-5" });
    expect(negative.statusCode).toBe(400);

    const overMax = await app.inject({ method: "GET", url: "/v1/stations?limit=101" });
    expect(overMax.statusCode).toBe(400);
    await app.close();
  });

  it("rejects a negative offset", async () => {
    const app = buildApp();
    const response = await app.inject({ method: "GET", url: "/v1/stations?offset=-1" });
    expect(response.statusCode).toBe(400);
    await app.close();
  });

  it("rejects an empty q and a q longer than the maximum", async () => {
    const app = buildApp();
    const empty = await app.inject({ method: "GET", url: "/v1/stations?q=" });
    expect(empty.statusCode).toBe(400);

    const tooLong = await app.inject({ method: "GET", url: `/v1/stations?q=${"a".repeat(201)}` });
    expect(tooLong.statusCode).toBe(400);
    await app.close();
  });
});
