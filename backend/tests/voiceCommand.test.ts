import { afterAll, afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { pool } from "../src/db/pool.js";
import { setUserRole } from "../src/repositories/usersRepository.js";

afterAll(async () => {
  await pool.end();
});

// getRankedStationsForCountry (Step 22) returns every active station in a
// country, with no q=/search filter to scope a test down the way other
// endpoints' tests can - the identical hazard tests/stationRanking.test.ts
// already documents and solves. Reusing that exact same two-layer fix
// here: a fresh, otherwise-untouched launch country per test (cycling
// through countries[1], [2], ... - never countries[0], which every other
// test file's own fixtures have accumulated well over a thousand stations
// in) plus hard-deleting every station this file creates in afterEach, so
// exact-membership assertions about "this country's ranked list" stay
// valid regardless of how many times this file has already run locally.
let createdStationIds: number[] = [];
let createdUserIds: number[] = [];

afterEach(async () => {
  if (createdStationIds.length > 0) {
    await pool.query("DELETE FROM radio_stations WHERE id = ANY($1)", [createdStationIds]);
    createdStationIds = [];
  }
  if (createdUserIds.length > 0) {
    await pool.query("DELETE FROM users WHERE id = ANY($1)", [createdUserIds]);
    createdUserIds = [];
  }
});

let nextCountryIndex = 1;
async function getIsolatedCountryId(app: ReturnType<typeof buildApp>): Promise<number> {
  const response = await app.inject({ method: "GET", url: "/v1/countries" });
  const countries = response.json().countries as Array<{ id: number; name: string }>;
  const index = nextCountryIndex++;
  const country = countries[index];
  if (!country) throw new Error(`expected at least ${index + 1} seeded countries`);
  return country.id;
}

async function getGenreId(app: ReturnType<typeof buildApp>, name: string): Promise<number> {
  const response = await app.inject({ method: "GET", url: "/v1/genres" });
  const genres = response.json().genres as Array<{ id: number; name: string }>;
  const genre = genres.find((g) => g.name === name);
  if (!genre) throw new Error(`expected a seeded genre named "${name}"`);
  return genre.id;
}

async function createAdminToken(app: ReturnType<typeof buildApp>, label: string): Promise<string> {
  const email = `voice-admin-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
  const password = "voice-admin-password-123";
  const register = await app.inject({
    method: "POST",
    url: "/v1/users",
    payload: { email, password, displayName: "Voice Admin" },
  });
  const userId = register.json().user.id as number;
  createdUserIds.push(userId);
  await setUserRole(userId, "admin");
  const login = await app.inject({ method: "POST", url: "/v1/auth/login", payload: { email, password } });
  return login.json().token as string;
}

async function createRegularAccount(
  app: ReturnType<typeof buildApp>,
  label: string,
): Promise<{ token: string; userId: number }> {
  const email = `voice-user-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
  const password = "voice-user-password-123";
  const register = await app.inject({
    method: "POST",
    url: "/v1/users",
    payload: { email, password, displayName: "Voice Regular User" },
  });
  const userId = register.json().user.id as number;
  createdUserIds.push(userId);
  const login = await app.inject({ method: "POST", url: "/v1/auth/login", payload: { email, password } });
  return { token: login.json().token as string, userId };
}

interface CreateStationOptions {
  countryId: number;
  adminToken: string;
  name: string;
  genreIds?: number[];
}

async function createStation(app: ReturnType<typeof buildApp>, options: CreateStationOptions): Promise<number> {
  const response = await app.inject({
    method: "POST",
    url: "/v1/stations",
    payload: {
      countryId: options.countryId,
      name: options.name,
      streamUrl: `https://stream.example.com/${Date.now()}-${Math.random().toString(36).slice(2)}`,
      genreIds: options.genreIds,
    },
    headers: { authorization: `Bearer ${options.adminToken}` },
  });
  expect(response.statusCode).toBe(201);
  const stationId = response.json().station.id as number;
  createdStationIds.push(stationId);
  return stationId;
}

async function sendCommand(app: ReturnType<typeof buildApp>, token: string, text: string) {
  return app.inject({
    method: "POST",
    url: "/v1/voice/command",
    payload: { text },
    headers: { authorization: `Bearer ${token}` },
  });
}

describe("POST /v1/voice/command", () => {
  it("requires authentication", async () => {
    const app = buildApp();
    const response = await app.inject({
      method: "POST",
      url: "/v1/voice/command",
      payload: { text: "pause" },
    });
    expect(response.statusCode).toBe(401);
    await app.close();
  });

  it("resolves every accepted playback-control phrase to the right action", async () => {
    const app = buildApp();
    const { token } = await createRegularAccount(app, "playback");

    const cases: Array<[string, string]> = [
      ["pause", "pause"],
      ["Pause it.", "pause"],
      ["resume", "resume"],
      ["unpause", "resume"],
      ["continue playing", "resume"],
      ["stop", "stop"],
      ["stop playing!", "stop"],
      ["next", "next"],
      ["skip", "next"],
      ["previous", "previous"],
      ["go back", "previous"],
      ["back", "previous"],
    ];

    for (const [text, expectedAction] of cases) {
      const response = await sendCommand(app, token, text);
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.intent).toBe("playback_control");
      expect(body.action).toBe(expectedAction);
      expect(body.station).toBeNull();
      expect(body.rankedStations).toBeNull();
      expect(body.candidates).toBeNull();
    }

    await app.close();
  });

  it("resolves an exact station name to play_station", async () => {
    const app = buildApp();
    const countryId = await getIsolatedCountryId(app);
    const adminToken = await createAdminToken(app, "exact-name");
    const { token } = await createRegularAccount(app, "exact-name");
    const marker = `Voice Unique Station ${Date.now()}${Math.random().toString(36).slice(2)}`;
    const stationId = await createStation(app, { countryId, adminToken, name: marker });

    const response = await sendCommand(app, token, `play ${marker}`);
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.intent).toBe("play_station");
    expect(body.station.id).toBe(stationId);
    expect(body.station.name).toBe(marker);

    await app.close();
  });

  it("returns ambiguous with candidates when multiple stations match", async () => {
    const app = buildApp();
    const countryId = await getIsolatedCountryId(app);
    const adminToken = await createAdminToken(app, "ambiguous");
    const { token } = await createRegularAccount(app, "ambiguous");
    const marker = `VoiceAmbig${Date.now()}${Math.random().toString(36).slice(2)}`;
    const stationAId = await createStation(app, { countryId, adminToken, name: `${marker} Alpha` });
    const stationBId = await createStation(app, { countryId, adminToken, name: `${marker} Beta` });

    const response = await sendCommand(app, token, `play ${marker}`);
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.intent).toBe("ambiguous");
    const candidateIds = (body.candidates as Array<{ id: number }>).map((c) => c.id);
    expect(new Set(candidateIds)).toEqual(new Set([stationAId, stationBId]));

    await app.close();
  });

  it("play <genre> in <country> filters the ranked list to only that genre", async () => {
    const app = buildApp();
    const countryId = await getIsolatedCountryId(app);
    const adminToken = await createAdminToken(app, "genre-country");
    const { token } = await createRegularAccount(app, "genre-country");
    const reggaeId = await getGenreId(app, "Reggae");
    const socaId = await getGenreId(app, "Soca");
    const reggaeStationId = await createStation(app, {
      countryId,
      adminToken,
      name: `Voice Reggae Station ${Date.now()}`,
      genreIds: [reggaeId],
    });
    const socaStationId = await createStation(app, {
      countryId,
      adminToken,
      name: `Voice Soca Station ${Date.now()}`,
      genreIds: [socaId],
    });

    const countriesResponse = await app.inject({ method: "GET", url: "/v1/countries" });
    const countryName = (countriesResponse.json().countries as Array<{ id: number; name: string }>).find(
      (c) => c.id === countryId,
    )?.name;

    const response = await sendCommand(app, token, `play reggae in ${countryName}`);
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.intent).toBe("play_ranked");
    expect(body.countryId).toBe(countryId);
    expect(body.genreId).toBe(reggaeId);
    const rankedIds = (body.rankedStations as Array<{ id: number }>).map((s) => s.id);
    expect(rankedIds).toContain(reggaeStationId);
    expect(rankedIds).not.toContain(socaStationId);

    await app.close();
  });

  it("play music in <country> (generic filler) includes every genre", async () => {
    const app = buildApp();
    const countryId = await getIsolatedCountryId(app);
    const adminToken = await createAdminToken(app, "generic-genre");
    const { token } = await createRegularAccount(app, "generic-genre");
    const reggaeId = await getGenreId(app, "Reggae");
    const socaId = await getGenreId(app, "Soca");
    const reggaeStationId = await createStation(app, {
      countryId,
      adminToken,
      name: `Voice Generic Reggae ${Date.now()}`,
      genreIds: [reggaeId],
    });
    const socaStationId = await createStation(app, {
      countryId,
      adminToken,
      name: `Voice Generic Soca ${Date.now()}`,
      genreIds: [socaId],
    });

    const countriesResponse = await app.inject({ method: "GET", url: "/v1/countries" });
    const countryName = (countriesResponse.json().countries as Array<{ id: number; name: string }>).find(
      (c) => c.id === countryId,
    )?.name;

    const response = await sendCommand(app, token, `play music in ${countryName}`);
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.intent).toBe("play_ranked");
    expect(body.genreId).toBeNull();
    const rankedIds = (body.rankedStations as Array<{ id: number }>).map((s) => s.id);
    expect(rankedIds).toContain(reggaeStationId);
    expect(rankedIds).toContain(socaStationId);

    await app.close();
  });

  it("returns not_found for an unrecognized country name", async () => {
    const app = buildApp();
    const { token } = await createRegularAccount(app, "bad-country");

    const response = await sendCommand(app, token, "play reggae in Narnia");
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.intent).toBe("not_found");
    expect(body.message).toContain("Narnia");

    await app.close();
  });

  it("returns not_found for an unrecognized genre paired with a valid country", async () => {
    const app = buildApp();
    const countryId = await getIsolatedCountryId(app);
    const { token } = await createRegularAccount(app, "bad-genre");
    const countriesResponse = await app.inject({ method: "GET", url: "/v1/countries" });
    const countryName = (countriesResponse.json().countries as Array<{ id: number; name: string }>).find(
      (c) => c.id === countryId,
    )?.name;

    const response = await sendCommand(app, token, `play polka in ${countryName}`);
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.intent).toBe("not_found");
    expect(body.message).toContain("polka");

    await app.close();
  });

  it("a bare genre command defaults to the caller's own profile country", async () => {
    const app = buildApp();
    const countryId = await getIsolatedCountryId(app);
    const { token } = await createRegularAccount(app, "default-country");
    const profileUpdate = await app.inject({
      method: "PATCH",
      url: "/v1/me",
      payload: { countryId },
      headers: { authorization: `Bearer ${token}` },
    });
    expect(profileUpdate.statusCode).toBe(200);

    const response = await sendCommand(app, token, "play reggae");
    expect(response.statusCode).toBe(200);
    const body = response.json();
    // No stations exist yet in this fresh isolated country for this genre,
    // so this correctly resolves to "not_found" rather than play_ranked -
    // the point of this test is that countryId was populated from the
    // profile at all, which not_found still reports.
    expect(body.countryId).toBe(countryId);

    await app.close();
  });

  it("a bare genre command with no profile country asks for one", async () => {
    const app = buildApp();
    const { token } = await createRegularAccount(app, "no-default-country");

    const response = await sendCommand(app, token, "play reggae");
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.intent).toBe("not_found");
    expect(body.message).toContain("specify a country");

    await app.close();
  });

  it("matches country name aliases (St Lucia, Trinidad without '& Tobago')", async () => {
    const app = buildApp();
    const { token } = await createRegularAccount(app, "aliases");
    const countriesResponse = await app.inject({ method: "GET", url: "/v1/countries" });
    const countries = countriesResponse.json().countries as Array<{ id: number; name: string }>;
    const saintLuciaId = countries.find((c) => c.name === "Saint Lucia")?.id;
    const trinidadId = countries.find((c) => c.name === "Trinidad & Tobago")?.id;
    const reggaeId = await getGenreId(app, "Reggae");
    const socaId = await getGenreId(app, "Soca");

    // Whether or not any station currently exists for these real, shared
    // countries, the country/genre *resolution* itself is proven by the
    // countryId/genreId echoed back - populated on the not_found path too
    // (see resolveRankedIntent) - not by the intent, which legitimately
    // depends on whatever stations happen to exist in the shared test
    // database at the moment this runs.
    const stLucia = await sendCommand(app, token, "play reggae in St Lucia");
    expect(stLucia.statusCode).toBe(200);
    expect(stLucia.json().countryId).toBe(saintLuciaId);
    expect(stLucia.json().genreId).toBe(reggaeId);

    const trinidad = await sendCommand(app, token, "play soca in Trinidad");
    expect(trinidad.statusCode).toBe(200);
    expect(trinidad.json().countryId).toBe(trinidadId);
    expect(trinidad.json().genreId).toBe(socaId);

    await app.close();
  });

  it("is case-insensitive and tolerates trailing punctuation", async () => {
    const app = buildApp();
    const { token } = await createRegularAccount(app, "case-punct");
    const countriesResponse = await app.inject({ method: "GET", url: "/v1/countries" });
    const jamaicaId = (countriesResponse.json().countries as Array<{ id: number; name: string }>).find(
      (c) => c.name === "Jamaica",
    )?.id;
    const reggaeId = await getGenreId(app, "Reggae");

    const response = await sendCommand(app, token, "Play REGGAE in Jamaica!");
    expect(response.statusCode).toBe(200);
    expect(response.json().intent).not.toBe("unrecognized");
    expect(response.json().countryId).toBe(jamaicaId);
    expect(response.json().genreId).toBe(reggaeId);

    await app.close();
  });

  it("returns unrecognized for a phrase outside the command grammar", async () => {
    const app = buildApp();
    const { token } = await createRegularAccount(app, "unrecognized");

    const response = await sendCommand(app, token, "turn on the lights");
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.intent).toBe("unrecognized");
    expect(body.message).not.toBeNull();

    await app.close();
  });

  it("rejects an empty command with 400", async () => {
    const app = buildApp();
    const { token } = await createRegularAccount(app, "empty");

    const response = await sendCommand(app, token, "");
    expect(response.statusCode).toBe(400);

    await app.close();
  });
});
