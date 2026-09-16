// Step 63 (Production QA): the generated OpenAPI document had never
// actually been checked against the real OpenAPI specification itself -
// every other test in this suite exercises real request/response
// behavior, but nothing verified the *document* GET /docs/json serves is
// structurally valid per spec, as opposed to merely "parses as JSON and
// Swagger UI doesn't crash on it."
//
// This found a real, previously-unnoticed gap: this codebase's own
// nullable-field convention (schemas/common.ts's `type: [X, "null"]`
// array form, used throughout) is valid JSON Schema but not valid under
// strict OpenAPI 3.0, which requires the OpenAPI-specific `nullable: true`
// keyword instead of a type array - confirmed via swagger-cli against the
// real OpenAPI 3.0 meta-schema, 430 structural violations. Fixed in
// app.ts by declaring the document as OpenAPI 3.1.0 (which adopted full
// JSON Schema 2020-12 compatibility specifically to remove that
// divergence) rather than rewriting every nullable field across the
// codebase to the OpenAPI-3.0-only keyword.
//
// @apidevtools/swagger-parser (MIT) is the same class of real, external,
// spec-aware validator as swagger-cli used to find and confirm the fix for
// this bug by hand - used here as a devDependency so the exact regression
// class (a future schema addition that's valid JSON Schema but not valid
// OpenAPI) fails CI automatically going forward, not just at the moment
// this gap happened to be checked by hand.
import { describe, expect, it } from "vitest";
import SwaggerParser from "@apidevtools/swagger-parser";
import { buildApp } from "../src/app.js";

describe("GET /docs/json - generated OpenAPI document (Step 63)", () => {
  it("is a structurally valid OpenAPI 3.1 document, not just parseable JSON", async () => {
    const app = buildApp();
    await app.ready();

    const response = await app.inject({ method: "GET", url: "/docs/json" });
    expect(response.statusCode).toBe(200);
    const spec = response.json();

    // The specific version that made this codebase's own `type: [X,
    // "null"]` nullable-field convention valid in the first place - if
    // this ever silently reverts to 3.0.x, the assertion below will catch
    // it directly rather than only failing on some unrelated future
    // schema addition.
    expect(spec.openapi).toMatch(/^3\.1\./);

    // Real, spec-aware structural validation - not a hand-rolled shape
    // check, the same validator class (swagger-cli/@apidevtools/swagger-
    // parser both wrap the official OpenAPI JSON Schema) used to find and
    // confirm the fix for the real bug this test now guards against.
    await expect(SwaggerParser.validate(structuredClone(spec))).resolves.toBeDefined();

    await app.close();
  });

  it("documents every real /v1 route this API actually serves, not a stale subset", async () => {
    const app = buildApp();
    await app.ready();

    const response = await app.inject({ method: "GET", url: "/docs/json" });
    const spec = response.json();
    const documentedPaths = Object.keys(spec.paths);

    // A handful of real, well-known routes across different route files -
    // not exhaustive, but enough to catch a whole route file silently
    // failing to register its schema (the same class of gap Step 59's
    // OWASP API9 audit already checked by hand for inventory management).
    for (const realPath of [
      "/v1/stations",
      "/v1/events",
      "/v1/me",
      "/v1/admin/ads/placements",
      "/v1/admin/ads/performance-daily",
      "/v1/me/notification-preferences",
    ]) {
      expect(documentedPaths).toContain(realPath);
    }

    await app.close();
  });
});
