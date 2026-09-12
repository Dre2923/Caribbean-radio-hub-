import { afterAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { pool } from "../src/db/pool.js";
import { setUserRole } from "../src/repositories/usersRepository.js";

async function getRealCountryId(app: ReturnType<typeof buildApp>): Promise<number> {
  const response = await app.inject({ method: "GET", url: "/v1/countries" });
  const countries = response.json().countries as Array<{ id: number }>;
  const country = countries[0];
  if (!country) throw new Error("expected at least one seeded country");
  return country.id;
}

async function createAdminAccount(
  app: ReturnType<typeof buildApp>,
  label: string,
): Promise<{ token: string; userId: number }> {
  const email = `stations-admin-${label}-${Date.now()}@example.com`;
  const password = "stations-admin-password-123";
  const register = await app.inject({
    method: "POST",
    url: "/v1/users",
    payload: { email, password, displayName: "Stations Admin" },
  });
  const userId = register.json().user.id as number;
  await setUserRole(userId, "admin");

  const login = await app.inject({ method: "POST", url: "/v1/auth/login", payload: { email, password } });
  return { token: login.json().token as string, userId };
}

async function createAdminToken(app: ReturnType<typeof buildApp>, label: string): Promise<string> {
  return (await createAdminAccount(app, label)).token;
}

async function createRegularToken(app: ReturnType<typeof buildApp>, label: string): Promise<string> {
  const email = `stations-user-${label}-${Date.now()}@example.com`;
  const password = "stations-user-password-123";
  await app.inject({
    method: "POST",
    url: "/v1/users",
    payload: { email, password, displayName: "Stations Regular User" },
  });
  const login = await app.inject({ method: "POST", url: "/v1/auth/login", payload: { email, password } });
  return login.json().token as string;
}

function uniqueStreamUrl(label: string): string {
  return `https://stream.example.com/${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

// One file-level afterAll, not one per describe: an afterAll nested inside
// an earlier describe block runs - and closes the pool - before a later
// sibling describe block's tests in the same file even start. Hit and
// fixed this same bug twice already in this build (tests/emailOutbox.test.ts,
// tests/adminRole.test.ts) - putting it at file scope from the start here.
afterAll(async () => {
  await pool.end();
});

async function getRealGenreIds(app: ReturnType<typeof buildApp>, count: number): Promise<number[]> {
  const response = await app.inject({ method: "GET", url: "/v1/genres" });
  const genres = response.json().genres as Array<{ id: number }>;
  if (genres.length < count) throw new Error(`expected at least ${count} seeded genres`);
  return genres.slice(0, count).map((g) => g.id);
}

async function getRealLanguageIds(app: ReturnType<typeof buildApp>, count: number): Promise<number[]> {
  const response = await app.inject({ method: "GET", url: "/v1/languages" });
  const languages = response.json().languages as Array<{ id: number }>;
  if (languages.length < count) throw new Error(`expected at least ${count} seeded languages`);
  return languages.slice(0, count).map((l) => l.id);
}

describe("radio stations", () => {
  it("rejects station creation with no token, and with a non-admin token", async () => {
    const app = buildApp();
    const countryId = await getRealCountryId(app);
    const payload = { countryId, name: "Auth Test Station", streamUrl: uniqueStreamUrl("auth") };

    const noToken = await app.inject({ method: "POST", url: "/v1/stations", payload });
    expect(noToken.statusCode).toBe(401);

    const regularToken = await createRegularToken(app, "authcheck");
    const nonAdmin = await app.inject({
      method: "POST",
      url: "/v1/stations",
      payload,
      headers: { authorization: `Bearer ${regularToken}` },
    });
    expect(nonAdmin.statusCode).toBe(403);

    await app.close();
  });

  it("lets an admin create, read, update, and delete a station end to end", async () => {
    const app = buildApp();
    const countryId = await getRealCountryId(app);
    const adminToken = await createAdminToken(app, "crud");
    const streamUrl = uniqueStreamUrl("crud");

    const create = await app.inject({
      method: "POST",
      url: "/v1/stations",
      payload: { countryId, name: "CRUD Test Station", streamUrl, description: "A test station" },
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(create.statusCode).toBe(201);
    const created = create.json().station;
    expect(created).toMatchObject({
      countryId,
      name: "CRUD Test Station",
      streamUrl,
      description: "A test station",
      websiteUrl: null,
      isActive: true,
    });
    const stationId = created.id as number;

    // Publicly readable, no auth required.
    const getPublic = await app.inject({ method: "GET", url: `/v1/stations/${stationId}` });
    expect(getPublic.statusCode).toBe(200);
    expect(getPublic.json().station.name).toBe("CRUD Test Station");

    // Shows up in the country's public listing.
    const list = await app.inject({ method: "GET", url: `/v1/stations?countryId=${countryId}` });
    expect(list.statusCode).toBe(200);
    const listedIds = (list.json().stations as Array<{ id: number }>).map((s) => s.id);
    expect(listedIds).toContain(stationId);

    // Admin updates the name.
    const update = await app.inject({
      method: "PATCH",
      url: `/v1/stations/${stationId}`,
      payload: { name: "Renamed Test Station" },
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(update.statusCode).toBe(200);
    expect(update.json().station.name).toBe("Renamed Test Station");
    // Untouched fields survive a partial update.
    expect(update.json().station.streamUrl).toBe(streamUrl);

    // Deactivating pulls it from the public listing and detail view...
    const deactivate = await app.inject({
      method: "PATCH",
      url: `/v1/stations/${stationId}`,
      payload: { isActive: false },
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(deactivate.statusCode).toBe(200);
    expect(deactivate.json().station.isActive).toBe(false);

    const getAfterDeactivate = await app.inject({ method: "GET", url: `/v1/stations/${stationId}` });
    expect(getAfterDeactivate.statusCode).toBe(404);

    const listAfterDeactivate = await app.inject({
      method: "GET",
      url: `/v1/stations?countryId=${countryId}`,
    });
    const idsAfterDeactivate = (listAfterDeactivate.json().stations as Array<{ id: number }>).map(
      (s) => s.id,
    );
    expect(idsAfterDeactivate).not.toContain(stationId);

    // ...but an admin can still find and hard-delete it directly by id.
    const remove = await app.inject({
      method: "DELETE",
      url: `/v1/stations/${stationId}`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(remove.statusCode).toBe(204);

    const removeAgain = await app.inject({
      method: "DELETE",
      url: `/v1/stations/${stationId}`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(removeAgain.statusCode).toBe(404);

    await app.close();
  });

  it("silently strips an unknown field rather than rejecting the request", async () => {
    const app = buildApp();
    const countryId = await getRealCountryId(app);
    const adminToken = await createAdminToken(app, "strip");

    const create = await app.inject({
      method: "POST",
      url: "/v1/stations",
      payload: {
        countryId,
        name: "Strip Test Station",
        streamUrl: uniqueStreamUrl("strip"),
        genre: "reggae",
      },
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(create.statusCode).toBe(201);
    expect(create.json().station).not.toHaveProperty("genre");

    await app.close();
  });

  it("rejects a duplicate stream URL with 409, and an unknown countryId with 400", async () => {
    const app = buildApp();
    const countryId = await getRealCountryId(app);
    const adminToken = await createAdminToken(app, "dupe");
    const streamUrl = uniqueStreamUrl("dupe");

    const first = await app.inject({
      method: "POST",
      url: "/v1/stations",
      payload: { countryId, name: "First Station", streamUrl },
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(first.statusCode).toBe(201);

    const duplicate = await app.inject({
      method: "POST",
      url: "/v1/stations",
      payload: { countryId, name: "Second Station", streamUrl },
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(duplicate.statusCode).toBe(409);

    const unknownCountry = await app.inject({
      method: "POST",
      url: "/v1/stations",
      payload: { countryId: 999_999, name: "Nowhere Station", streamUrl: uniqueStreamUrl("nowhere") },
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(unknownCountry.statusCode).toBe(400);

    await app.close();
  });

  it("returns 404 for a nonexistent station id on get, update, and delete", async () => {
    const app = buildApp();
    const adminToken = await createAdminToken(app, "notfound");

    const get = await app.inject({ method: "GET", url: "/v1/stations/999999999" });
    expect(get.statusCode).toBe(404);

    const update = await app.inject({
      method: "PATCH",
      url: "/v1/stations/999999999",
      payload: { name: "Ghost Station" },
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(update.statusCode).toBe(404);

    const remove = await app.inject({
      method: "DELETE",
      url: "/v1/stations/999999999",
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(remove.statusCode).toBe(404);

    await app.close();
  });

  it("rejects update and delete from a non-admin token", async () => {
    const app = buildApp();
    const countryId = await getRealCountryId(app);
    const adminToken = await createAdminToken(app, "gate-setup");
    const regularToken = await createRegularToken(app, "gate");

    const create = await app.inject({
      method: "POST",
      url: "/v1/stations",
      payload: { countryId, name: "Gate Test Station", streamUrl: uniqueStreamUrl("gate") },
      headers: { authorization: `Bearer ${adminToken}` },
    });
    const stationId = create.json().station.id as number;

    const update = await app.inject({
      method: "PATCH",
      url: `/v1/stations/${stationId}`,
      payload: { name: "Hijacked Name" },
      headers: { authorization: `Bearer ${regularToken}` },
    });
    expect(update.statusCode).toBe(403);

    const remove = await app.inject({
      method: "DELETE",
      url: `/v1/stations/${stationId}`,
      headers: { authorization: `Bearer ${regularToken}` },
    });
    expect(remove.statusCode).toBe(403);

    await app.close();
  });
});

describe("radio station genres and languages", () => {
  it("creates a station tagged with genres and languages, hydrated in the response", async () => {
    const app = buildApp();
    const countryId = await getRealCountryId(app);
    const adminToken = await createAdminToken(app, "tag-create");
    const genreIds = await getRealGenreIds(app, 2);
    const languageIds = await getRealLanguageIds(app, 2);

    const create = await app.inject({
      method: "POST",
      url: "/v1/stations",
      payload: {
        countryId,
        name: "Tagged Station",
        streamUrl: uniqueStreamUrl("tag-create"),
        genreIds,
        languageIds,
      },
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(create.statusCode).toBe(201);
    const station = create.json().station;
    expect(station.genres.map((g: { id: number }) => g.id).sort()).toEqual([...genreIds].sort());
    expect(station.languages.map((l: { id: number }) => l.id).sort()).toEqual(
      [...languageIds].sort(),
    );
    // Hydrated, not just echoed ids - each entry carries its real name.
    expect(station.genres[0]).toHaveProperty("name");
    expect(station.languages[0]).toHaveProperty("code");

    // The public read path returns the same tags.
    const get = await app.inject({ method: "GET", url: `/v1/stations/${station.id}` });
    expect(get.json().station.genres.map((g: { id: number }) => g.id).sort()).toEqual(
      [...genreIds].sort(),
    );

    await app.close();
  });

  it("creates a station with no tags when genreIds/languageIds are omitted", async () => {
    const app = buildApp();
    const countryId = await getRealCountryId(app);
    const adminToken = await createAdminToken(app, "tag-omit");

    const create = await app.inject({
      method: "POST",
      url: "/v1/stations",
      payload: { countryId, name: "Untagged Station", streamUrl: uniqueStreamUrl("tag-omit") },
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(create.statusCode).toBe(201);
    expect(create.json().station.genres).toEqual([]);
    expect(create.json().station.languages).toEqual([]);

    await app.close();
  });

  it("replaces the full tag set on update, leaves it untouched when omitted, and clears it with []", async () => {
    const app = buildApp();
    const countryId = await getRealCountryId(app);
    const adminToken = await createAdminToken(app, "tag-update");
    const [genreA, genreB, genreC] = await getRealGenreIds(app, 3);

    const create = await app.inject({
      method: "POST",
      url: "/v1/stations",
      payload: {
        countryId,
        name: "Retag Station",
        streamUrl: uniqueStreamUrl("tag-update"),
        genreIds: [genreA, genreB],
      },
      headers: { authorization: `Bearer ${adminToken}` },
    });
    const stationId = create.json().station.id as number;

    // Replaces the set entirely - genreA is gone, genreC is new, genreB
    // was never re-sent and is gone too (this isn't an additive merge).
    const replace = await app.inject({
      method: "PATCH",
      url: `/v1/stations/${stationId}`,
      payload: { genreIds: [genreC] },
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(replace.statusCode).toBe(200);
    expect(replace.json().station.genres.map((g: { id: number }) => g.id)).toEqual([genreC]);

    // Omitting genreIds on an unrelated update leaves the current set alone.
    const untouched = await app.inject({
      method: "PATCH",
      url: `/v1/stations/${stationId}`,
      payload: { name: "Retag Station Renamed" },
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(untouched.json().station.genres.map((g: { id: number }) => g.id)).toEqual([genreC]);

    // An explicit [] clears it.
    const cleared = await app.inject({
      method: "PATCH",
      url: `/v1/stations/${stationId}`,
      payload: { genreIds: [] },
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(cleared.json().station.genres).toEqual([]);

    await app.close();
  });

  it("rejects an unknown genreId or languageId with 400", async () => {
    const app = buildApp();
    const countryId = await getRealCountryId(app);
    const adminToken = await createAdminToken(app, "tag-invalid");

    const badGenre = await app.inject({
      method: "POST",
      url: "/v1/stations",
      payload: {
        countryId,
        name: "Bad Genre Station",
        streamUrl: uniqueStreamUrl("bad-genre"),
        genreIds: [999_999],
      },
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(badGenre.statusCode).toBe(400);

    const badLanguage = await app.inject({
      method: "POST",
      url: "/v1/stations",
      payload: {
        countryId,
        name: "Bad Language Station",
        streamUrl: uniqueStreamUrl("bad-language"),
        languageIds: [999_999],
      },
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(badLanguage.statusCode).toBe(400);

    await app.close();
  });

  it("tolerates a duplicate id within the same request instead of erroring", async () => {
    const app = buildApp();
    const countryId = await getRealCountryId(app);
    const adminToken = await createAdminToken(app, "tag-dupe");
    const [genreId] = await getRealGenreIds(app, 1);

    const create = await app.inject({
      method: "POST",
      url: "/v1/stations",
      payload: {
        countryId,
        name: "Dupe Tag Station",
        streamUrl: uniqueStreamUrl("tag-dupe"),
        genreIds: [genreId, genreId],
      },
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(create.statusCode).toBe(201);
    expect(create.json().station.genres).toHaveLength(1);

    await app.close();
  });

  it("cascades: deleting a station removes its genre/language associations", async () => {
    const app = buildApp();
    const countryId = await getRealCountryId(app);
    const adminToken = await createAdminToken(app, "tag-cascade");
    const genreIds = await getRealGenreIds(app, 1);

    const create = await app.inject({
      method: "POST",
      url: "/v1/stations",
      payload: {
        countryId,
        name: "Cascade Station",
        streamUrl: uniqueStreamUrl("tag-cascade"),
        genreIds,
      },
      headers: { authorization: `Bearer ${adminToken}` },
    });
    const stationId = create.json().station.id as number;

    const beforeDelete = await pool.query("SELECT 1 FROM station_genres WHERE station_id = $1", [
      stationId,
    ]);
    expect(beforeDelete.rowCount).toBe(1);

    await app.inject({
      method: "DELETE",
      url: `/v1/stations/${stationId}`,
      headers: { authorization: `Bearer ${adminToken}` },
    });

    const afterDelete = await pool.query("SELECT 1 FROM station_genres WHERE station_id = $1", [
      stationId,
    ]);
    expect(afterDelete.rowCount).toBe(0);

    await app.close();
  });
});

describe("radio station search, filtering, and pagination", () => {
  it("finds a station by a case-insensitive substring match on its name", async () => {
    const app = buildApp();
    const countryId = await getRealCountryId(app);
    const adminToken = await createAdminToken(app, "search");
    // Unique enough that no other test's data could ever coincidentally
    // match this search term.
    const token = `ZzyxSearch${Date.now()}${Math.floor(Math.random() * 1e6)}`;

    const create = await app.inject({
      method: "POST",
      url: "/v1/stations",
      payload: { countryId, name: `Roots ${token} Radio`, streamUrl: uniqueStreamUrl("search") },
      headers: { authorization: `Bearer ${adminToken}` },
    });
    const stationId = create.json().station.id as number;

    // Matches regardless of case, and as a substring, not just a prefix.
    const found = await app.inject({ method: "GET", url: `/v1/stations?q=${token.toLowerCase()}` });
    expect(found.statusCode).toBe(200);
    const foundIds = (found.json().stations as Array<{ id: number }>).map((s) => s.id);
    expect(foundIds).toEqual([stationId]);
    expect(found.json().pagination.total).toBe(1);

    const notFound = await app.inject({ method: "GET", url: "/v1/stations?q=NoSuchStationExists" });
    const notFoundIds = (notFound.json().stations as Array<{ id: number }>).map((s) => s.id);
    expect(notFoundIds).not.toContain(stationId);

    await app.close();
  });

  it("treats a literal % or _ in the search term as a literal character, not a wildcard", async () => {
    const app = buildApp();
    const countryId = await getRealCountryId(app);
    const adminToken = await createAdminToken(app, "search-escape");
    const token = `Esc${Date.now()}${Math.floor(Math.random() * 1e6)}`;

    await app.inject({
      method: "POST",
      url: "/v1/stations",
      payload: { countryId, name: `${token} Radio`, streamUrl: uniqueStreamUrl("search-escape") },
      headers: { authorization: `Bearer ${adminToken}` },
    });

    // A literal "%" in the query must not act as an ILIKE wildcard - a
    // search for "<token>%" should match nothing, since the actual name
    // has no literal percent sign in it.
    const response = await app.inject({ method: "GET", url: `/v1/stations?q=${token}%25` });
    expect(response.statusCode).toBe(200);
    expect(response.json().stations).toEqual([]);

    await app.close();
  });

  it("filters by genreId and languageId independently and combined", async () => {
    const app = buildApp();
    const countryId = await getRealCountryId(app);
    const adminToken = await createAdminToken(app, "filter");
    const [genreA, genreB] = await getRealGenreIds(app, 2);
    const [languageA, languageB] = await getRealLanguageIds(app, 2);
    const marker = `Filter${Date.now()}${Math.floor(Math.random() * 1e6)}`;

    const stationA = await app.inject({
      method: "POST",
      url: "/v1/stations",
      payload: {
        countryId,
        name: `${marker} Station A`,
        streamUrl: uniqueStreamUrl("filter-a"),
        genreIds: [genreA],
        languageIds: [languageA],
      },
      headers: { authorization: `Bearer ${adminToken}` },
    });
    const stationAId = stationA.json().station.id as number;

    const stationB = await app.inject({
      method: "POST",
      url: "/v1/stations",
      payload: {
        countryId,
        name: `${marker} Station B`,
        streamUrl: uniqueStreamUrl("filter-b"),
        genreIds: [genreB],
        languageIds: [languageB],
      },
      headers: { authorization: `Bearer ${adminToken}` },
    });
    const stationBId = stationB.json().station.id as number;

    // Scoped with the shared search marker throughout so the assertions
    // are exact-equality against a fully controlled result set, not just
    // "contains" checks against the whole live catalog.
    const byGenreA = await app.inject({
      method: "GET",
      url: `/v1/stations?q=${marker}&genreId=${genreA}`,
    });
    expect((byGenreA.json().stations as Array<{ id: number }>).map((s) => s.id)).toEqual([
      stationAId,
    ]);

    const byLanguageB = await app.inject({
      method: "GET",
      url: `/v1/stations?q=${marker}&languageId=${languageB}`,
    });
    expect((byLanguageB.json().stations as Array<{ id: number }>).map((s) => s.id)).toEqual([
      stationBId,
    ]);

    // AND semantics: genreA + languageB never co-occur on either station,
    // so combining them narrows to nothing.
    const impossibleCombo = await app.inject({
      method: "GET",
      url: `/v1/stations?q=${marker}&genreId=${genreA}&languageId=${languageB}`,
    });
    expect(impossibleCombo.json().stations).toEqual([]);

    // Both stations still match with just the shared marker and no tag
    // filter.
    const both = await app.inject({ method: "GET", url: `/v1/stations?q=${marker}` });
    expect((both.json().stations as Array<{ id: number }>).map((s) => s.id).sort()).toEqual(
      [stationAId, stationBId].sort(),
    );

    await app.close();
  });

  it("paginates with limit/offset and reports an accurate total across pages", async () => {
    const app = buildApp();
    const countryId = await getRealCountryId(app);
    const adminToken = await createAdminToken(app, "paginate");
    const marker = `Page${Date.now()}${Math.floor(Math.random() * 1e6)}`;

    const createdIds: number[] = [];
    for (let i = 0; i < 3; i++) {
      const create = await app.inject({
        method: "POST",
        url: "/v1/stations",
        // Zero-padded so default name-ascending order is deterministic.
        payload: { countryId, name: `${marker} 0${i}`, streamUrl: uniqueStreamUrl(`page-${i}`) },
        headers: { authorization: `Bearer ${adminToken}` },
      });
      createdIds.push(create.json().station.id as number);
    }

    const pageOne = await app.inject({ method: "GET", url: `/v1/stations?q=${marker}&limit=2&offset=0` });
    expect(pageOne.json().stations).toHaveLength(2);
    expect(pageOne.json().pagination).toEqual({ total: 3, limit: 2, offset: 0 });
    expect((pageOne.json().stations as Array<{ id: number }>).map((s) => s.id)).toEqual(
      createdIds.slice(0, 2),
    );

    const pageTwo = await app.inject({ method: "GET", url: `/v1/stations?q=${marker}&limit=2&offset=2` });
    expect(pageTwo.json().stations).toHaveLength(1);
    expect(pageTwo.json().pagination).toEqual({ total: 3, limit: 2, offset: 2 });
    expect((pageTwo.json().stations as Array<{ id: number }>).map((s) => s.id)).toEqual([
      createdIds[2],
    ]);

    // Defaults apply when limit/offset are omitted entirely.
    const defaults = await app.inject({ method: "GET", url: `/v1/stations?q=${marker}` });
    expect(defaults.json().pagination).toEqual({ total: 3, limit: 50, offset: 0 });
    expect(defaults.json().stations).toHaveLength(3);

    await app.close();
  });

  it("accepts limit at exactly the documented maximum", async () => {
    const app = buildApp();
    const response = await app.inject({ method: "GET", url: "/v1/stations?limit=100" });
    expect(response.statusCode).toBe(200);
    expect(response.json().pagination.limit).toBe(100);

    await app.close();
  });
});

describe("radio station input hygiene", () => {
  it("trims leading/trailing whitespace from name, description, and streamUrl on create", async () => {
    const app = buildApp();
    const countryId = await getRealCountryId(app);
    const adminToken = await createAdminToken(app, "trim-create");
    const rawStreamUrl = uniqueStreamUrl("trim-create");

    const create = await app.inject({
      method: "POST",
      url: "/v1/stations",
      payload: {
        countryId,
        name: "  Untrimmed Station  ",
        description: "  a padded description  ",
        streamUrl: `  ${rawStreamUrl}  `,
      },
      headers: { authorization: `Bearer ${adminToken}` },
    });

    expect(create.statusCode).toBe(201);
    expect(create.json().station).toMatchObject({
      name: "Untrimmed Station",
      description: "a padded description",
      streamUrl: rawStreamUrl,
    });

    await app.close();
  });

  it("trims whitespace on update too", async () => {
    const app = buildApp();
    const countryId = await getRealCountryId(app);
    const adminToken = await createAdminToken(app, "trim-update");

    const create = await app.inject({
      method: "POST",
      url: "/v1/stations",
      payload: { countryId, name: "Trim Update Station", streamUrl: uniqueStreamUrl("trim-update") },
      headers: { authorization: `Bearer ${adminToken}` },
    });
    const stationId = create.json().station.id as number;

    const update = await app.inject({
      method: "PATCH",
      url: `/v1/stations/${stationId}`,
      payload: { name: "  Renamed With Padding  " },
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(update.statusCode).toBe(200);
    expect(update.json().station.name).toBe("Renamed With Padding");

    await app.close();
  });

  it("rejects an all-whitespace name rather than silently storing garbage", async () => {
    const app = buildApp();
    const countryId = await getRealCountryId(app);
    const adminToken = await createAdminToken(app, "trim-whitespace-only");

    const create = await app.inject({
      method: "POST",
      url: "/v1/stations",
      payload: {
        countryId,
        name: "     ",
        streamUrl: uniqueStreamUrl("trim-whitespace-only"),
      },
      headers: { authorization: `Bearer ${adminToken}` },
    });
    // Trimmed to an empty string before the minLength: 1 check runs, so
    // this is a clean 400, not a station silently created with a
    // whitespace-only (effectively blank) name.
    expect(create.statusCode).toBe(400);

    await app.close();
  });
});

describe("GET /v1/admin/stations", () => {
  it("rejects a missing token and a non-admin token", async () => {
    const app = buildApp();
    const regularToken = await createRegularToken(app, "admin-list-authcheck");

    const noToken = await app.inject({ method: "GET", url: "/v1/admin/stations" });
    expect(noToken.statusCode).toBe(401);

    const nonAdmin = await app.inject({
      method: "GET",
      url: "/v1/admin/stations",
      headers: { authorization: `Bearer ${regularToken}` },
    });
    expect(nonAdmin.statusCode).toBe(403);

    await app.close();
  });

  it("sees an inactive station that the public endpoint hides, and can filter by isActive", async () => {
    const app = buildApp();
    const countryId = await getRealCountryId(app);
    const adminToken = await createAdminToken(app, "admin-list-visibility");
    const marker = `AdminList${Date.now()}${Math.floor(Math.random() * 1e6)}`;

    const create = await app.inject({
      method: "POST",
      url: "/v1/stations",
      payload: { countryId, name: `${marker} Station`, streamUrl: uniqueStreamUrl("admin-list") },
      headers: { authorization: `Bearer ${adminToken}` },
    });
    const stationId = create.json().station.id as number;

    await app.inject({
      method: "PATCH",
      url: `/v1/stations/${stationId}`,
      payload: { isActive: false },
      headers: { authorization: `Bearer ${adminToken}` },
    });

    // Confirms the gap this route closes: the public endpoint can never
    // see this station once it's inactive...
    const publicList = await app.inject({ method: "GET", url: `/v1/stations?q=${marker}` });
    expect(publicList.json().stations).toEqual([]);

    // ...but the admin listing does, with no isActive filter at all.
    const adminListAll = await app.inject({
      method: "GET",
      url: `/v1/admin/stations?q=${marker}`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(adminListAll.statusCode).toBe(200);
    const allIds = (adminListAll.json().stations as Array<{ id: number }>).map((s) => s.id);
    expect(allIds).toEqual([stationId]);

    // isActive=true excludes it...
    const adminListActive = await app.inject({
      method: "GET",
      url: `/v1/admin/stations?q=${marker}&isActive=true`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(adminListActive.json().stations).toEqual([]);

    // ...and isActive=false finds exactly it.
    const adminListInactive = await app.inject({
      method: "GET",
      url: `/v1/admin/stations?q=${marker}&isActive=false`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    const inactiveIds = (adminListInactive.json().stations as Array<{ id: number }>).map(
      (s) => s.id,
    );
    expect(inactiveIds).toEqual([stationId]);

    await app.close();
  });

  it("supports the same genre/language/country filters and pagination as the public route", async () => {
    const app = buildApp();
    const countryId = await getRealCountryId(app);
    const adminToken = await createAdminToken(app, "admin-list-filters");
    const [genreId] = await getRealGenreIds(app, 1);
    const marker = `AdminFilter${Date.now()}${Math.floor(Math.random() * 1e6)}`;

    const create = await app.inject({
      method: "POST",
      url: "/v1/stations",
      payload: {
        countryId,
        name: `${marker} Station`,
        streamUrl: uniqueStreamUrl("admin-list-filters"),
        genreIds: [genreId],
      },
      headers: { authorization: `Bearer ${adminToken}` },
    });
    const stationId = create.json().station.id as number;

    const filtered = await app.inject({
      method: "GET",
      url: `/v1/admin/stations?countryId=${countryId}&genreId=${genreId}&q=${marker}&limit=10&offset=0`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(filtered.statusCode).toBe(200);
    expect((filtered.json().stations as Array<{ id: number }>).map((s) => s.id)).toEqual([
      stationId,
    ]);
    expect(filtered.json().pagination).toEqual({ total: 1, limit: 10, offset: 0 });

    await app.close();
  });

  it("silently strips an unknown query field rather than rejecting the request", async () => {
    // Same removeAdditional: true behavior already documented for body
    // fields (POST /v1/users, POST /v1/stations) - AJV's compiler option
    // applies uniformly across body/querystring/params, not just bodies.
    const app = buildApp();
    const adminToken = await createAdminToken(app, "admin-list-validation");

    const response = await app.inject({
      method: "GET",
      url: "/v1/admin/stations?bogus=1",
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(response.statusCode).toBe(200);

    await app.close();
  });

  it("rejects a non-boolean isActive query param", async () => {
    const app = buildApp();
    const adminToken = await createAdminToken(app, "admin-list-isactive-validation");

    const response = await app.inject({
      method: "GET",
      url: "/v1/admin/stations?isActive=not-a-boolean",
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(response.statusCode).toBe(400);

    await app.close();
  });
});

describe("radio station data quality - near-duplicate stream URLs (Step 16)", () => {
  it("rejects a near-duplicate stream URL (different host case) with 409", async () => {
    const app = buildApp();
    const countryId = await getRealCountryId(app);
    const adminToken = await createAdminToken(app, "near-dupe-case");
    const streamUrl = uniqueStreamUrl("near-dupe-case");

    const first = await app.inject({
      method: "POST",
      url: "/v1/stations",
      payload: { countryId, name: "Near Dupe Original", streamUrl },
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(first.statusCode).toBe(201);

    // Same URL, only the host's letter case differs - a byte-for-byte
    // comparison (and the exact-match stream_url UNIQUE constraint alone)
    // would let this through as "different," even though it's the same
    // origin per RFC 3986.
    const caseVariant = streamUrl.replace("stream.example.com", "STREAM.EXAMPLE.COM");
    const near = await app.inject({
      method: "POST",
      url: "/v1/stations",
      payload: { countryId, name: "Near Dupe Copy", streamUrl: caseVariant },
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(near.statusCode).toBe(409);
    expect(near.json().message).toMatch(/equivalent stream URL/i);

    await app.close();
  });

  it("rejects a near-duplicate stream URL (incidental trailing slash on the root path) with 409", async () => {
    const app = buildApp();
    const countryId = await getRealCountryId(app);
    const adminToken = await createAdminToken(app, "near-dupe-slash");
    // Deliberately a bare origin (no path) for this one - normalizeStreamUrl
    // only folds a trailing slash away on the *root* path; a URL with a
    // real path already covers the "not folded" side in the test above.
    const streamUrl = `https://near-dupe-slash-${Date.now()}-${Math.random()
      .toString(36)
      .slice(2)}.example.com`;

    const first = await app.inject({
      method: "POST",
      url: "/v1/stations",
      payload: { countryId, name: "Trailing Slash Original", streamUrl },
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(first.statusCode).toBe(201);

    const withTrailingSlash = await app.inject({
      method: "POST",
      url: "/v1/stations",
      payload: { countryId, name: "Trailing Slash Copy", streamUrl: `${streamUrl}/` },
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(withTrailingSlash.statusCode).toBe(409);
    expect(withTrailingSlash.json().message).toMatch(/equivalent stream URL/i);

    await app.close();
  });

  it("still returns the original exact-duplicate message for a byte-for-byte repeat", async () => {
    // Guards against a regression where the new near-duplicate check
    // silently swallows the original Step 12 exact-match message.
    const app = buildApp();
    const countryId = await getRealCountryId(app);
    const adminToken = await createAdminToken(app, "exact-dupe-message");
    const streamUrl = uniqueStreamUrl("exact-dupe-message");

    await app.inject({
      method: "POST",
      url: "/v1/stations",
      payload: { countryId, name: "Exact Dupe Original", streamUrl },
      headers: { authorization: `Bearer ${adminToken}` },
    });
    const exact = await app.inject({
      method: "POST",
      url: "/v1/stations",
      payload: { countryId, name: "Exact Dupe Copy", streamUrl },
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(exact.statusCode).toBe(409);
    expect(exact.json().message).toMatch(/already registered: /i);
    expect(exact.json().message).not.toMatch(/equivalent stream URL/i);

    await app.close();
  });

  it("rejects updating a station's streamUrl to a near-duplicate of another station's", async () => {
    const app = buildApp();
    const countryId = await getRealCountryId(app);
    const adminToken = await createAdminToken(app, "near-dupe-patch");
    const existingUrl = uniqueStreamUrl("near-dupe-patch-existing");
    const ownUrl = uniqueStreamUrl("near-dupe-patch-own");

    await app.inject({
      method: "POST",
      url: "/v1/stations",
      payload: { countryId, name: "Existing Station", streamUrl: existingUrl },
      headers: { authorization: `Bearer ${adminToken}` },
    });
    const create = await app.inject({
      method: "POST",
      url: "/v1/stations",
      payload: { countryId, name: "Station To Update", streamUrl: ownUrl },
      headers: { authorization: `Bearer ${adminToken}` },
    });
    const stationId = create.json().station.id as number;

    const nearDuplicateOfExisting = existingUrl.replace("stream.example.com", "STREAM.EXAMPLE.COM");
    const patch = await app.inject({
      method: "PATCH",
      url: `/v1/stations/${stationId}`,
      payload: { streamUrl: nearDuplicateOfExisting },
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(patch.statusCode).toBe(409);

    await app.close();
  });

  it("allows re-saving a station's own streamUrl unchanged without a false-positive conflict", async () => {
    // Postgres's UNIQUE constraint never conflicts a row with its own
    // pre-existing value, but this is worth proving directly rather than
    // assuming - a PATCH that doesn't touch streamUrl at all, and one that
    // resends the exact same value, must both still succeed.
    const app = buildApp();
    const countryId = await getRealCountryId(app);
    const adminToken = await createAdminToken(app, "self-patch");
    const streamUrl = uniqueStreamUrl("self-patch");

    const create = await app.inject({
      method: "POST",
      url: "/v1/stations",
      payload: { countryId, name: "Self Patch Station", streamUrl },
      headers: { authorization: `Bearer ${adminToken}` },
    });
    const stationId = create.json().station.id as number;

    const patch = await app.inject({
      method: "PATCH",
      url: `/v1/stations/${stationId}`,
      payload: { streamUrl, name: "Self Patch Station Renamed" },
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(patch.statusCode).toBe(200);
    expect(patch.json().station.streamUrl).toBe(streamUrl);

    await app.close();
  });
});

describe("radio station curation - deactivation audit trail (Step 17)", () => {
  it("records the acting admin and a timestamp when deactivating, and clears them on reactivation", async () => {
    const app = buildApp();
    const countryId = await getRealCountryId(app);
    const { token: adminToken, userId: adminUserId } = await createAdminAccount(app, "audit-trail");
    const streamUrl = uniqueStreamUrl("audit-trail");

    const create = await app.inject({
      method: "POST",
      url: "/v1/stations",
      payload: { countryId, name: "Audit Trail Station", streamUrl },
      headers: { authorization: `Bearer ${adminToken}` },
    });
    const stationId = create.json().station.id as number;
    // Never deactivated yet - all three audit fields start null.
    expect(create.json().station.deactivatedAt).toBeNull();
    expect(create.json().station.deactivatedByUserId).toBeNull();
    expect(create.json().station.deactivationReason).toBeNull();

    const deactivate = await app.inject({
      method: "PATCH",
      url: `/v1/stations/${stationId}`,
      payload: { isActive: false, deactivationReason: "Stream has been dead for a week" },
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(deactivate.statusCode).toBe(200);
    const deactivated = deactivate.json().station;
    expect(deactivated.isActive).toBe(false);
    expect(deactivated.deactivatedByUserId).toBe(adminUserId);
    expect(deactivated.deactivationReason).toBe("Stream has been dead for a week");
    expect(new Date(deactivated.deactivatedAt).getTime()).not.toBeNaN();

    const reactivate = await app.inject({
      method: "PATCH",
      url: `/v1/stations/${stationId}`,
      payload: { isActive: true },
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(reactivate.statusCode).toBe(200);
    const reactivated = reactivate.json().station;
    expect(reactivated.isActive).toBe(true);
    // Reactivating clears the prior deactivation record - the reason it
    // was inactive no longer applies once it's active again.
    expect(reactivated.deactivatedAt).toBeNull();
    expect(reactivated.deactivatedByUserId).toBeNull();
    expect(reactivated.deactivationReason).toBeNull();

    await app.close();
  });

  it("records deactivation without a reason when none is given", async () => {
    const app = buildApp();
    const countryId = await getRealCountryId(app);
    const { token: adminToken, userId: adminUserId } = await createAdminAccount(app, "audit-no-reason");
    const streamUrl = uniqueStreamUrl("audit-no-reason");

    const create = await app.inject({
      method: "POST",
      url: "/v1/stations",
      payload: { countryId, name: "No Reason Station", streamUrl },
      headers: { authorization: `Bearer ${adminToken}` },
    });
    const stationId = create.json().station.id as number;

    const deactivate = await app.inject({
      method: "PATCH",
      url: `/v1/stations/${stationId}`,
      payload: { isActive: false },
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(deactivate.statusCode).toBe(200);
    expect(deactivate.json().station.deactivatedByUserId).toBe(adminUserId);
    expect(deactivate.json().station.deactivationReason).toBeNull();
    expect(deactivate.json().station.deactivatedAt).not.toBeNull();

    await app.close();
  });

  it("rejects deactivationReason sent without isActive: false", async () => {
    const app = buildApp();
    const countryId = await getRealCountryId(app);
    const adminToken = await createAdminToken(app, "audit-reason-without-deactivate");
    const streamUrl = uniqueStreamUrl("audit-reason-without-deactivate");

    const create = await app.inject({
      method: "POST",
      url: "/v1/stations",
      payload: { countryId, name: "Reason Without Deactivate", streamUrl },
      headers: { authorization: `Bearer ${adminToken}` },
    });
    const stationId = create.json().station.id as number;

    // No isActive at all.
    const withoutIsActive = await app.inject({
      method: "PATCH",
      url: `/v1/stations/${stationId}`,
      payload: { deactivationReason: "Should not be accepted" },
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(withoutIsActive.statusCode).toBe(400);

    // isActive explicitly true.
    const withActiveTrue = await app.inject({
      method: "PATCH",
      url: `/v1/stations/${stationId}`,
      payload: { isActive: true, deactivationReason: "Should not be accepted either" },
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(withActiveTrue.statusCode).toBe(400);

    await app.close();
  });

  it("trims a deactivationReason's incidental whitespace like every other free-text field", async () => {
    const app = buildApp();
    const countryId = await getRealCountryId(app);
    const adminToken = await createAdminToken(app, "audit-trim");
    const streamUrl = uniqueStreamUrl("audit-trim");

    const create = await app.inject({
      method: "POST",
      url: "/v1/stations",
      payload: { countryId, name: "Trim Reason Station", streamUrl },
      headers: { authorization: `Bearer ${adminToken}` },
    });
    const stationId = create.json().station.id as number;

    const deactivate = await app.inject({
      method: "PATCH",
      url: `/v1/stations/${stationId}`,
      payload: { isActive: false, deactivationReason: "  Duplicate of station #123  " },
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(deactivate.statusCode).toBe(200);
    expect(deactivate.json().station.deactivationReason).toBe("Duplicate of station #123");

    await app.close();
  });

  it("shows the audit trail on the admin listing route for a curated-off station", async () => {
    const app = buildApp();
    const countryId = await getRealCountryId(app);
    const { token: adminToken, userId: adminUserId } = await createAdminAccount(app, "audit-admin-list");
    const streamUrl = uniqueStreamUrl("audit-admin-list");

    const create = await app.inject({
      method: "POST",
      url: "/v1/stations",
      payload: { countryId, name: "Admin List Audit Station", streamUrl },
      headers: { authorization: `Bearer ${adminToken}` },
    });
    const stationId = create.json().station.id as number;

    await app.inject({
      method: "PATCH",
      url: `/v1/stations/${stationId}`,
      payload: { isActive: false, deactivationReason: "Rights issue - pending review" },
      headers: { authorization: `Bearer ${adminToken}` },
    });

    const adminList = await app.inject({
      method: "GET",
      url: `/v1/admin/stations?countryId=${countryId}&isActive=false`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(adminList.statusCode).toBe(200);
    const found = (
      adminList.json().stations as Array<{
        id: number;
        deactivatedByUserId: number;
        deactivationReason: string;
      }>
    ).find((s) => s.id === stationId);
    expect(found).toBeDefined();
    expect(found?.deactivatedByUserId).toBe(adminUserId);
    expect(found?.deactivationReason).toBe("Rights issue - pending review");

    await app.close();
  });
});
