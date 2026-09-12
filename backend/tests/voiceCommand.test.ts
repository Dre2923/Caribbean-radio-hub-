import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import { pool } from "../src/db/pool.js";
import { setUserRole } from "../src/repositories/usersRepository.js";

afterAll(async () => {
  await pool.end();
});

// getRankedStationsForCountry (Step 22) and listEvents (Steps 24-30)
// return every active station/event in a country, with no q=/search
// filter to scope a test down the way other endpoints' tests can. Unlike
// tests/stationRanking.test.ts (which asserts exact order/count and so
// needs one genuinely untouched country per test), every assertion in
// this file checks membership of a specific, just-created id
// (`.toContain`/`.not.toContain`) rather than the shape of the whole
// list - accumulated cruft from other tests/other local runs in the same
// country can never make one of those assertions wrong. So countries[1..]
// (never countries[0], which every other test file's fixtures have
// accumulated well over a thousand stations in) are cycled with a plain
// modulo rather than needing as many distinct countries as this file has
// tests; every station/event this file creates is still hard-deleted in
// afterEach as the actual, independent hygiene guarantee.
let createdStationIds: number[] = [];
let createdUserIds: number[] = [];
let createdEventIds: number[] = [];

afterEach(async () => {
  if (createdStationIds.length > 0) {
    await pool.query("DELETE FROM radio_stations WHERE id = ANY($1)", [createdStationIds]);
    createdStationIds = [];
  }
  if (createdEventIds.length > 0) {
    await pool.query("DELETE FROM events WHERE id = ANY($1)", [createdEventIds]);
    createdEventIds = [];
  }
  if (createdUserIds.length > 0) {
    await pool.query("DELETE FROM users WHERE id = ANY($1)", [createdUserIds]);
    createdUserIds = [];
  }
});

let nextCountryOffset = 0;
async function getIsolatedCountryId(app: ReturnType<typeof buildApp>): Promise<number> {
  const response = await app.inject({ method: "GET", url: "/v1/countries" });
  const countries = response.json().countries as Array<{ id: number; name: string }>;
  const usableCountries = countries.slice(1); // never countries[0] - see this file's own top comment
  if (usableCountries.length === 0) throw new Error("expected at least 2 seeded countries");
  const country = usableCountries[nextCountryOffset % usableCountries.length];
  nextCountryOffset++;
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

async function getCategoryId(app: ReturnType<typeof buildApp>, name: string): Promise<number> {
  const response = await app.inject({ method: "GET", url: "/v1/event-categories" });
  const categories = response.json().categories as Array<{ id: number; name: string }>;
  const category = categories.find((c) => c.name === name);
  if (!category) throw new Error(`expected a seeded event category named "${name}"`);
  return category.id;
}

function futureIso(hoursFromNow: number): string {
  return new Date(Date.now() + hoursFromNow * 60 * 60 * 1000).toISOString();
}

interface CreateEventOptions {
  countryId: number;
  token: string;
  title: string;
  startsAt: string;
  categoryIds?: number[];
}

// Creates a real event via the actual submission route, exactly like a
// real user would - admin auto-approval (Step 24) means an admin token
// here always yields an immediately-approved event, which is what these
// tests need for the public-events-search behavior resolveEventSearch
// calls into.
async function createEventViaApi(app: ReturnType<typeof buildApp>, options: CreateEventOptions): Promise<number> {
  const response = await app.inject({
    method: "POST",
    url: "/v1/events",
    payload: {
      countryId: options.countryId,
      title: options.title,
      startsAt: options.startsAt,
      categoryIds: options.categoryIds,
    },
    headers: { authorization: `Bearer ${options.token}` },
  });
  expect(response.statusCode).toBe(201);
  const eventId = response.json().event.id as number;
  createdEventIds.push(eventId);
  return eventId;
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

  it("resolves every accepted help phrase to a categorized topic list (Step 37)", async () => {
    const app = buildApp();
    const { token } = await createRegularAccount(app, "help");

    const phrases = ["help", "Help!", "what can I say", "what can you do", "commands", "show me commands"];
    for (const phrase of phrases) {
      const response = await sendCommand(app, token, phrase);
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.intent).toBe("help");
      const topics = body.helpTopics as Array<{ category: string; examples: string[] }>;
      expect(topics.length).toBeGreaterThan(0);
      for (const topic of topics) {
        expect(typeof topic.category).toBe("string");
        expect(topic.examples.length).toBeGreaterThan(0);
      }
      // Every other field this intent doesn't use stays null - the same
      // "one intent, its own fields populated, everything else null"
      // contract as every other intent.
      expect(body.station).toBeNull();
      expect(body.events).toBeNull();
      expect(body.action).toBeNull();
    }

    await app.close();
  });

  it("a phrase that merely contains a help word isn't misclassified as help", async () => {
    const app = buildApp();
    const { token } = await createRegularAccount(app, "help-collision");

    // "help" only matches as the *entire* normalized command, the same
    // exact-phrase-match discipline as PLAYBACK_CONTROL_PHRASES - a
    // substring match here would make an unrelated command ("play help me
    // radio") wrongly resolve as a request for help instead of whatever
    // it actually named.
    const response = await sendCommand(app, token, "play help me radio");
    expect(response.statusCode).toBe(200);
    expect(response.json().intent).not.toBe("help");

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

  it("rate-limits to 30 requests per minute (Step 36)", async () => {
    const app = buildApp();
    const { token } = await createRegularAccount(app, "rate-limit");

    const responses = [];
    for (let i = 0; i < 31; i++) {
      responses.push(await sendCommand(app, token, "pause"));
    }
    const statusCodes = responses.map((r) => r.statusCode);
    // The first 30 succeed; the 31st is the one this limit exists to
    // catch. Checking every code (not just the last one) proves the limit
    // doesn't kick in early and reject a request it shouldn't.
    expect(statusCodes.slice(0, 30).every((code) => code === 200)).toBe(true);
    expect(statusCodes[30]).toBe(429);

    await app.close();
  });
});

describe("POST /v1/voice/command - event search (Step 35)", () => {
  it("finds events in a named country", async () => {
    const app = buildApp();
    const countryId = await getIsolatedCountryId(app);
    const adminToken = await createAdminToken(app, "events-country");
    const { token } = await createRegularAccount(app, "events-country");
    const eventId = await createEventViaApi(app, {
      countryId,
      token: adminToken,
      title: `Voice Event Country ${Date.now()}`,
      startsAt: futureIso(48),
    });

    const countriesResponse = await app.inject({ method: "GET", url: "/v1/countries" });
    const countryName = (countriesResponse.json().countries as Array<{ id: number; name: string }>).find(
      (c) => c.id === countryId,
    )?.name;

    const response = await sendCommand(app, token, `events in ${countryName}`);
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.intent).toBe("search_events");
    expect(body.countryId).toBe(countryId);
    const eventIds = (body.events as Array<{ id: number }>).map((e) => e.id);
    expect(eventIds).toContain(eventId);

    await app.close();
  });

  it("the 'find' lead-in resolves identically to the bare form", async () => {
    const app = buildApp();
    const countryId = await getIsolatedCountryId(app);
    const adminToken = await createAdminToken(app, "lead-in");
    const { token } = await createRegularAccount(app, "lead-in");
    const eventId = await createEventViaApi(app, {
      countryId,
      token: adminToken,
      title: `Voice Event LeadIn ${Date.now()}`,
      startsAt: futureIso(48),
    });
    const countriesResponse = await app.inject({ method: "GET", url: "/v1/countries" });
    const countryName = (countriesResponse.json().countries as Array<{ id: number; name: string }>).find(
      (c) => c.id === countryId,
    )?.name;

    const response = await sendCommand(app, token, `find events in ${countryName}`);
    expect(response.statusCode).toBe(200);
    const eventIds = (response.json().events as Array<{ id: number }>).map((e) => e.id);
    expect(eventIds).toContain(eventId);

    await app.close();
  });

  it("filters by event category", async () => {
    const app = buildApp();
    const countryId = await getIsolatedCountryId(app);
    const adminToken = await createAdminToken(app, "category");
    const { token } = await createRegularAccount(app, "category");
    const carnivalId = await getCategoryId(app, "Carnival");
    const sportsId = await getCategoryId(app, "Sports");
    const carnivalEventId = await createEventViaApi(app, {
      countryId,
      token: adminToken,
      title: `Voice Carnival Event ${Date.now()}`,
      startsAt: futureIso(48),
      categoryIds: [carnivalId],
    });
    const sportsEventId = await createEventViaApi(app, {
      countryId,
      token: adminToken,
      title: `Voice Sports Event ${Date.now()}`,
      startsAt: futureIso(48),
      categoryIds: [sportsId],
    });
    const countriesResponse = await app.inject({ method: "GET", url: "/v1/countries" });
    const countryName = (countriesResponse.json().countries as Array<{ id: number; name: string }>).find(
      (c) => c.id === countryId,
    )?.name;

    const response = await sendCommand(app, token, `carnival events in ${countryName}`);
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.categoryId).toBe(carnivalId);
    const eventIds = (body.events as Array<{ id: number }>).map((e) => e.id);
    expect(eventIds).toContain(carnivalEventId);
    expect(eventIds).not.toContain(sportsEventId);

    await app.close();
  });

  it("a bare category command defaults to the caller's own profile country", async () => {
    const app = buildApp();
    const countryId = await getIsolatedCountryId(app);
    const { token } = await createRegularAccount(app, "events-default-country");
    const profileUpdate = await app.inject({
      method: "PATCH",
      url: "/v1/me",
      payload: { countryId },
      headers: { authorization: `Bearer ${token}` },
    });
    expect(profileUpdate.statusCode).toBe(200);

    const response = await sendCommand(app, token, "carnival events");
    expect(response.statusCode).toBe(200);
    expect(response.json().countryId).toBe(countryId);

    await app.close();
  });

  it("returns not_found for an unrecognized country name", async () => {
    const app = buildApp();
    const { token } = await createRegularAccount(app, "events-bad-country");

    const response = await sendCommand(app, token, "events in Narnia");
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.intent).toBe("not_found");
    expect(body.message).toContain("Narnia");

    await app.close();
  });

  it("returns not_found for an unrecognized category paired with a valid country", async () => {
    const app = buildApp();
    const countryId = await getIsolatedCountryId(app);
    const { token } = await createRegularAccount(app, "events-bad-category");
    const countriesResponse = await app.inject({ method: "GET", url: "/v1/countries" });
    const countryName = (countriesResponse.json().countries as Array<{ id: number; name: string }>).find(
      (c) => c.id === countryId,
    )?.name;

    const response = await sendCommand(app, token, `skateboarding events in ${countryName}`);
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.intent).toBe("not_found");
    expect(body.message).toContain("skateboarding");

    await app.close();
  });

  it("never surfaces a pending (unapproved) event", async () => {
    const app = buildApp();
    const countryId = await getIsolatedCountryId(app);
    const { token: submitterToken } = await createRegularAccount(app, "pending-submitter");
    const { token } = await createRegularAccount(app, "pending-searcher");
    const pendingEventId = await createEventViaApi(app, {
      countryId,
      token: submitterToken,
      title: `Voice Pending Event ${Date.now()}`,
      startsAt: futureIso(48),
    });

    const countriesResponse = await app.inject({ method: "GET", url: "/v1/countries" });
    const countryName = (countriesResponse.json().countries as Array<{ id: number; name: string }>).find(
      (c) => c.id === countryId,
    )?.name;

    const response = await sendCommand(app, token, `events in ${countryName}`);
    expect(response.statusCode).toBe(200);
    const body = response.json();
    // A regular user's own submission starts pending (Step 24) - never
    // visible through the public listing this resolver calls into.
    expect(body.intent).toBe("not_found");
    const eventIds = ((body.events as Array<{ id: number }> | null) ?? []).map((e) => e.id);
    expect(eventIds).not.toContain(pendingEventId);

    await app.close();
  });

  it("resolves 'this weekend' to a Saturday-through-Sunday UTC range", async () => {
    const app = buildApp();
    const { token } = await createRegularAccount(app, "weekend-range");

    const response = await sendCommand(app, token, "events this weekend");
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.dateRangeStart).not.toBeNull();
    expect(body.dateRangeEnd).not.toBeNull();
    const start = new Date(body.dateRangeStart as string);
    const end = new Date(body.dateRangeEnd as string);
    // Saturday (6) unless today already IS Sunday (0), in which case the
    // remaining weekend starts today - see commandResolver.ts's
    // getThisWeekendRange for the exact rule.
    expect([6, 0]).toContain(start.getUTCDay());
    expect(end.getUTCDay()).toBe(0);
    expect(end.getTime()).toBeGreaterThan(start.getTime());

    await app.close();
  });

  it("on an actual Sunday, 'this weekend' starts today rather than skipping to next Saturday", async () => {
    // Deterministic, not left to chance on whatever day this suite
    // happens to run - the general (non-Sunday) branch of
    // getThisWeekendRange would, if it ever regressed to also run on a
    // Sunday, advance 6 days to the *next* Saturday instead of treating
    // today as the remainder of the current weekend. 2026-09-13 is a real
    // Sunday (UTC).
    // Only Date is faked (not setTimeout/setInterval/etc.) - this test
    // still makes real database round trips through app.inject(), and
    // faking every timer would stall Node's own internals (the pg driver
    // included) waiting on a clock that never advances.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-13T15:00:00.000Z"));
    try {
      const app = buildApp();
      const { token } = await createRegularAccount(app, "weekend-sunday");

      const response = await sendCommand(app, token, "events this weekend");
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.dateRangeStart).toBe("2026-09-13T00:00:00.000Z");
      expect(body.dateRangeEnd).toBe("2026-09-13T23:59:59.999Z");

      await app.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("actually filters events to within the resolved 'today' range, not just a fixed window", async () => {
    const app = buildApp();
    const countryId = await getIsolatedCountryId(app);
    const adminToken = await createAdminToken(app, "today-filter");
    const { token } = await createRegularAccount(app, "today-filter");
    const countriesResponse = await app.inject({ method: "GET", url: "/v1/countries" });
    const countryName = (countriesResponse.json().countries as Array<{ id: number; name: string }>).find(
      (c) => c.id === countryId,
    )?.name;

    // Resolve "today" first so the fixture events are placed relative to
    // the server's own actual computed boundaries, not a guessed
    // wall-clock offset - avoids any midnight-UTC-boundary flakiness.
    const probe = await sendCommand(app, token, `events in ${countryName} today`);
    const rangeEnd = new Date(probe.json().dateRangeEnd as string);

    const insideId = await createEventViaApi(app, {
      countryId,
      token: adminToken,
      title: `Voice Today Inside ${Date.now()}`,
      startsAt: new Date(rangeEnd.getTime() - 60_000).toISOString(),
    });
    const outsideId = await createEventViaApi(app, {
      countryId,
      token: adminToken,
      title: `Voice Today Outside ${Date.now()}`,
      startsAt: new Date(rangeEnd.getTime() + 5 * 24 * 60 * 60 * 1000).toISOString(),
    });

    const response = await sendCommand(app, token, `events in ${countryName} today`);
    expect(response.statusCode).toBe(200);
    const body = response.json();
    const eventIds = ((body.events as Array<{ id: number }> | null) ?? []).map((e) => e.id);
    expect(eventIds).toContain(insideId);
    expect(eventIds).not.toContain(outsideId);

    await app.close();
  });
});

// Step 38: closes out the Voice System bucket (Steps 34-38) with an
// adversarial hardening pass across the whole grammar built in Steps
// 34-37, not just this step's own new code - the same "the last step in
// a bucket reviews/hardens the whole bucket" shape as Step 18/23/30's own
// closing steps. Every case here demands exactly one thing: a real,
// sensible 200 (or the documented 400 for oversized input) and never a
// crash - MAX_VOICE_COMMAND_TEXT_LENGTH's schema-level minLength:1 can't
// by itself guarantee non-garbage content, so the resolver itself has to
// degrade gracefully on its own.
describe("POST /v1/voice/command - adversarial hardening (Step 38)", () => {
  it("rejects text longer than MAX_VOICE_COMMAND_TEXT_LENGTH with 400", async () => {
    const app = buildApp();
    const { token } = await createRegularAccount(app, "too-long");

    const response = await sendCommand(app, token, "a".repeat(501));
    expect(response.statusCode).toBe(400);

    await app.close();
  });

  it("accepts text at exactly the MAX_VOICE_COMMAND_TEXT_LENGTH boundary", async () => {
    const app = buildApp();
    const { token } = await createRegularAccount(app, "at-boundary");

    const response = await sendCommand(app, token, "a".repeat(500));
    expect(response.statusCode).toBe(200);

    await app.close();
  });

  it("whitespace-only text (passes schema minLength but is empty after trim) resolves as unrecognized, not a crash", async () => {
    const app = buildApp();
    const { token } = await createRegularAccount(app, "whitespace-only");

    const response = await sendCommand(app, token, "     ");
    expect(response.statusCode).toBe(200);
    expect(response.json().intent).toBe("unrecognized");

    await app.close();
  });

  it("tolerates trailing emoji/decoration on a country name - normalization strips non-alphanumerics", async () => {
    const app = buildApp();
    const { token } = await createRegularAccount(app, "emoji-country");

    const response = await sendCommand(app, token, "play reggae in Jamaica 🇯🇲🎵");
    expect(response.statusCode).toBe(200);
    // The country still resolves correctly despite the trailing emoji -
    // proven by countryId being populated (Jamaica's real id), regardless
    // of whether any station happens to exist for the intent itself.
    expect(response.json().countryId).not.toBeNull();

    await app.close();
  });

  it("a leading emoji before the whole command doesn't crash - falls through to unrecognized", async () => {
    const app = buildApp();
    const { token } = await createRegularAccount(app, "emoji-leading");

    // The "play"/"events" grammar is anchored at the start of the string
    // (^play, ^events) - a leading decoration character breaks that
    // anchor by design (this is a bounded, documented grammar, not an
    // attempt at general NLP robustness), so this is expected to fall
    // through to unrecognized rather than "fixed" to strip arbitrary
    // leading noise. The only real requirement is that it never crashes.
    const response = await sendCommand(app, token, "🎵 play reggae in Jamaica");
    expect(response.statusCode).toBe(200);
    expect(typeof response.json().intent).toBe("string");

    await app.close();
  });

  it("embedded newlines and control characters never crash the resolver", async () => {
    const app = buildApp();
    const { token } = await createRegularAccount(app, "newlines");

    const response = await sendCommand(app, token, "play\nreggae\nin\njamaica");
    expect(response.statusCode).toBe(200);
    expect(typeof response.json().intent).toBe("string");

    await app.close();
  });

  it("excess internal whitespace between words never crashes the resolver", async () => {
    const app = buildApp();
    const { token } = await createRegularAccount(app, "excess-whitespace");

    const response = await sendCommand(app, token, "play    reggae   in   jamaica");
    expect(response.statusCode).toBe(200);
    expect(typeof response.json().intent).toBe("string");

    await app.close();
  });

  it("comma/punctuation-heavy phrasing never crashes the resolver", async () => {
    const app = buildApp();
    const { token } = await createRegularAccount(app, "punctuation-heavy");

    const response = await sendCommand(app, token, "PLAY, REGGAE, IN, JAMAICA???");
    expect(response.statusCode).toBe(200);
    expect(typeof response.json().intent).toBe("string");

    await app.close();
  });

  it("a SQL-injection-shaped command is inert - resolves safely and never touches the database's data", async () => {
    const app = buildApp();
    const { token } = await createRegularAccount(app, "sql-injection");

    const before = await pool.query("SELECT count(*) FROM radio_stations");

    const response = await sendCommand(app, token, "play '; DROP TABLE radio_stations; --");
    expect(response.statusCode).toBe(200);
    expect(response.json().intent).toBe("not_found");

    const after = await pool.query("SELECT count(*) FROM radio_stations");
    expect(after.rows[0].count).toBe(before.rows[0].count);

    await app.close();
  });

  it("a SQL-injection-shaped country name in a genre-and-country command is inert", async () => {
    const app = buildApp();
    const { token } = await createRegularAccount(app, "sql-injection-country");

    const before = await pool.query("SELECT count(*) FROM countries");

    const response = await sendCommand(app, token, "play reggae in Jamaica'; DROP TABLE countries; --");
    expect(response.statusCode).toBe(200);
    expect(response.json().intent).toBe("not_found");

    const after = await pool.query("SELECT count(*) FROM countries");
    expect(after.rows[0].count).toBe(before.rows[0].count);

    await app.close();
  });
});
