import type { PoolClient } from "pg";
import { withTransaction } from "../db/transaction.js";
import { query } from "../db/pool.js";
import type { EventCategory } from "./eventCategoriesRepository.js";

export type EventStatus = "pending" | "approved" | "rejected";

export interface Event {
  id: number;
  countryId: number;
  title: string;
  description: string | null;
  venue: string | null;
  // Step 30: a fuller street/city address, distinct from the venue NAME
  // above ("National Stadium" vs. "Arthur Wint Drive, Kingston").
  venueAddress: string | null;
  // Step 30: both null or both set, never one alone - enforced at the
  // database level (events_location_lat_long_together), not just here.
  latitude: number | null;
  longitude: number | null;
  startsAt: string;
  endsAt: string | null;
  imageUrl: string | null;
  ticketUrl: string | null;
  status: EventStatus;
  categories: EventCategory[];
  createdByUserId: number | null;
  // Step 27: only ever populated as a side effect of a status decision -
  // an admin's own submission auto-approved at creation, or a later PATCH
  // that sets status - never independently settable. Always null for a
  // submission nobody has moderated yet.
  moderatedAt: string | null;
  moderatedByUserId: number | null;
  moderationReason: string | null;
  createdAt: string;
  updatedAt: string;
  // Step 30: the great-circle distance in kilometers from the point a
  // GET /v1/events?nearLatitude=&nearLongitude= search was centered on -
  // null except when that search was actually used, since the concept
  // "distance from where" is meaningless outside a proximity query.
  distanceKm: number | null;
}

interface EventRow {
  id: number;
  country_id: number;
  title: string;
  description: string | null;
  venue: string | null;
  venue_address: string | null;
  latitude: number | null;
  longitude: number | null;
  starts_at: string;
  ends_at: string | null;
  image_url: string | null;
  ticket_url: string | null;
  status: EventStatus;
  categories: EventCategory[] | null;
  created_by_user_id: number | null;
  moderated_at: string | null;
  moderated_by_user_id: number | null;
  moderation_reason: string | null;
  created_at: string;
  updated_at: string;
  distance_km: number | null;
  total_count: string;
}

export class InvalidCountryError extends Error {
  constructor(countryId: number) {
    super(`No country with id ${countryId}`);
    this.name = "InvalidCountryError";
  }
}

export class InvalidEndsAtError extends Error {
  constructor() {
    super("endsAt must be after startsAt");
    this.name = "InvalidEndsAtError";
  }
}

export class InvalidEventCategoryError extends Error {
  constructor() {
    super("One or more categoryIds do not match a known event category");
    this.name = "InvalidEventCategoryError";
  }
}

// Step 28: raised when a submission's (countryId, title, startsAt) exactly
// matches an existing non-rejected event's - see the migration that adds
// events_country_title_starts_at_unique for why this is a partial index
// (excludes rejected events) and deliberately exact-match rather than a
// fuzzy time-window match.
export class DuplicateEventError extends Error {
  constructor() {
    super(
      "An event with this title already exists for this country and start time",
    );
    this.name = "DuplicateEventError";
  }
}

// Step 30: raised for any of the three location CHECK constraints -
// latitude/longitude provided without its pair, or either one outside its
// real-world valid range. One error type for all three since the client
// fix is the same shape of correction either way ("check latitude and
// longitude").
export class InvalidLocationError extends Error {
  constructor() {
    super(
      "latitude and longitude must both be provided together, and each within its valid range",
    );
    this.name = "InvalidLocationError";
  }
}

// Same reasoning as stationsRepository.escapeLikePattern: Postgres's default
// LIKE/ILIKE escape character is already backslash, so escaping a caller's
// raw search text this way (before it's wrapped in %...% and bound as a
// single parameter - never concatenated into the query string) stops a
// search for a literal "%" or "_" from being misread as a wildcard. Not a
// SQL-injection concern either way - purely about search results actually
// matching what the user typed.
function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

// Step 28: trim + collapse internal whitespace runs + lowercase - the same
// modest, deliberately-bounded normalization philosophy as
// streamUrlValidation.ts's normalizeStreamUrl (case only, no fuzzy
// matching): catches "the exact same title, retyped or copy-pasted with
// different capitalization or stray spacing," never attempts to catch two
// genuinely different titles that merely sound similar.
export function normalizeEventTitle(title: string): string {
  return title.trim().toLowerCase().replace(/\s+/g, " ");
}

const UNIQUE_VIOLATION = "23505";
const FOREIGN_KEY_VIOLATION = "23503";
const CHECK_VIOLATION = "23514";
const ENDS_AT_CONSTRAINT = "events_ends_at_after_starts_at";
const DUPLICATE_EVENT_CONSTRAINT = "events_country_title_starts_at_unique";
const LOCATION_CONSTRAINTS = new Set([
  "events_location_lat_long_together",
  "events_latitude_range",
  "events_longitude_range",
]);

// Same COUNT(*) OVER() reasoning as stationsRepository.STATION_SELECT - the
// filtered-but-unpaginated total in one round trip, harmless overhead on the
// single-row lookups (findEventById) that also use this base query. The
// categories subquery mirrors STATION_SELECT's genres/languages subqueries
// exactly, for the identical reason: a direct JOIN against the junction
// table would fan an event with N categories out into N duplicated rows
// before any aggregation could run.
//
// distanceExprSql, when given, is the great-circle-distance SQL expression
// a proximity search computes (see listEvents) - injected here as the
// distance_km column so every caller (including a plain findEventById)
// shares one row shape, rather than having a second, near-duplicate SELECT
// just for the proximity-search case. Callers that aren't doing a
// proximity search get a literal NULL, matching distanceKm's "meaningless
// outside a proximity query" contract.
function buildEventSelect(distanceExprSql = "NULL::double precision"): string {
  return `
    SELECT
      e.id, e.country_id, e.title, e.description, e.venue,
      e.venue_address, e.latitude, e.longitude, e.starts_at, e.ends_at,
      e.image_url, e.ticket_url, e.status, e.created_by_user_id,
      e.moderated_at, e.moderated_by_user_id, e.moderation_reason,
      e.created_at, e.updated_at,
      COALESCE(
        (SELECT json_agg(json_build_object('id', c.id, 'name', c.name) ORDER BY c.name)
         FROM event_category_assignments eca JOIN event_categories c ON c.id = eca.category_id
         WHERE eca.event_id = e.id),
        '[]'
      ) AS categories,
      ${distanceExprSql} AS distance_km,
      COUNT(*) OVER() AS total_count
    FROM events e
  `;
}

const EVENT_SELECT = buildEventSelect();

function toEvent(row: EventRow): Event {
  return {
    id: row.id,
    countryId: row.country_id,
    title: row.title,
    description: row.description,
    venue: row.venue,
    venueAddress: row.venue_address,
    latitude: row.latitude,
    longitude: row.longitude,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    imageUrl: row.image_url,
    ticketUrl: row.ticket_url,
    status: row.status,
    categories: row.categories ?? [],
    createdByUserId: row.created_by_user_id,
    moderatedAt: row.moderated_at,
    moderatedByUserId: row.moderated_by_user_id,
    moderationReason: row.moderation_reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    distanceKm: row.distance_km !== null ? Number(row.distance_km) : null,
  };
}

function toEventWriteError(err: unknown, countryId?: number): unknown {
  if (hasPgErrorCode(err, UNIQUE_VIOLATION) && pgConstraintName(err) === DUPLICATE_EVENT_CONSTRAINT) {
    return new DuplicateEventError();
  }
  if (hasPgErrorCode(err, FOREIGN_KEY_VIOLATION)) {
    const constraint = pgConstraintName(err);
    if (constraint?.includes("category")) return new InvalidEventCategoryError();
    if (countryId !== undefined) return new InvalidCountryError(countryId);
  }
  if (hasPgErrorCode(err, CHECK_VIOLATION)) {
    const constraint = pgConstraintName(err);
    if (constraint === ENDS_AT_CONSTRAINT) return new InvalidEndsAtError();
    if (constraint !== undefined && LOCATION_CONSTRAINTS.has(constraint)) {
      return new InvalidLocationError();
    }
  }
  return err;
}

function hasPgErrorCode(err: unknown, code: string): boolean {
  return typeof err === "object" && err !== null && "code" in err && err.code === code;
}

function pgConstraintName(err: unknown): string | undefined {
  if (typeof err === "object" && err !== null && "constraint" in err) {
    const constraint = (err as { constraint?: unknown }).constraint;
    return typeof constraint === "string" ? constraint : undefined;
  }
  return undefined;
}

// Replaces an event's full set of category associations (DELETE then bulk
// INSERT) rather than diffing - the identical pattern and reasoning as
// stationsRepository.replaceStationGenres. ON CONFLICT DO NOTHING tolerates
// a duplicate id appearing twice in the caller's own array. A pg client,
// not the pool directly, so this always runs inside the same transaction
// as the event row it belongs to.
async function replaceEventCategories(
  client: PoolClient,
  eventId: number,
  categoryIds: number[],
): Promise<void> {
  await client.query("DELETE FROM event_category_assignments WHERE event_id = $1", [eventId]);
  const uniqueIds = [...new Set(categoryIds)];
  if (uniqueIds.length === 0) return;
  const values = uniqueIds.map((_, i) => `($1, $${i + 2})`).join(", ");
  await client.query(
    `INSERT INTO event_category_assignments (event_id, category_id) VALUES ${values} ON CONFLICT DO NOTHING`,
    [eventId, ...uniqueIds],
  );
}

export interface NewEvent {
  countryId: number;
  title: string;
  description?: string | null;
  venue?: string | null;
  venueAddress?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  startsAt: string;
  endsAt?: string | null;
  imageUrl?: string | null;
  ticketUrl?: string | null;
  // Never client-supplied - see routes/events.ts for exactly how this is
  // derived from the submitter's role (admin -> 'approved', regular user ->
  // 'pending').
  status: EventStatus;
  categoryIds?: number[];
  createdByUserId?: number | null;
  // Step 27: set only when this creation *is* the moderation decision - an
  // admin's own submission, auto-approved at creation (routes/events.ts
  // passes the same admin's id here). A regular user's pending submission
  // passes undefined/null, leaving moderatedAt/moderatedByUserId both null
  // until a future PATCH actually moderates it.
  moderatedByUserId?: number | null;
}

export async function createEvent(input: NewEvent): Promise<Event> {
  let newId: number;
  try {
    newId = await withTransaction(async (client) => {
      const result = await client.query<{ id: number }>(
        `INSERT INTO events
           (country_id, title, title_normalized, description, venue, venue_address, latitude, longitude, starts_at, ends_at, image_url, ticket_url, status, created_by_user_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
         RETURNING id`,
        [
          input.countryId,
          input.title,
          normalizeEventTitle(input.title),
          input.description ?? null,
          input.venue ?? null,
          input.venueAddress ?? null,
          input.latitude ?? null,
          input.longitude ?? null,
          input.startsAt,
          input.endsAt ?? null,
          input.imageUrl ?? null,
          input.ticketUrl ?? null,
          input.status,
          input.createdByUserId ?? null,
        ],
      );
      const id = result.rows[0].id;
      if (input.categoryIds) {
        await replaceEventCategories(client, id, input.categoryIds);
      }
      // A follow-up statement in the same transaction, not a fifth+
      // INSERT column - moderated_at needs the database's own now(), not
      // an app-server Date, to stay consistent with every other
      // DB-generated timestamp on this row (created_at/updated_at).
      if (input.moderatedByUserId != null) {
        await client.query(
          "UPDATE events SET moderated_by_user_id = $1, moderated_at = now() WHERE id = $2",
          [input.moderatedByUserId, id],
        );
      }
      return id;
    });
  } catch (err) {
    throw toEventWriteError(err, input.countryId);
  }

  const event = await findEventById(newId);
  if (!event) {
    throw new Error(`Event ${newId} vanished immediately after being created`);
  }
  return event;
}

export const DEFAULT_EVENT_LIST_LIMIT = 50;
export const MAX_EVENT_LIST_LIMIT = 100;

export interface EventListFilter {
  countryId?: number;
  categoryId?: number;
  // Case-insensitive substring match against the event title. Plain ILIKE,
  // not a full-text index - the identical reasoning and scale assumption as
  // StationListFilter.search.
  search?: string;
  // Inclusive bounds against starts_at - "what's happening this weekend"
  // is exactly the query an events listing needs to answer that a radio
  // catalog never did, so this has no station-search analog.
  startsAfter?: string;
  startsBefore?: string;
  // Tri-state, the same "undefined means no filter" convention as
  // StationListFilter.isActive: the public route (routes/events.ts) always
  // passes 'approved' explicitly; the admin moderation queue leaves this
  // undefined to see every status, or filters to exactly one.
  status?: EventStatus;
  // Step 29: true excludes an event that has already concluded
  // (COALESCE(endsAt, startsAt) < now()). Undefined means no filter at
  // all - same tri-state convention as status/isActive elsewhere - but
  // unlike status (a moderation-state concept the public route hard-codes
  // and never exposes), "upcoming vs. past" is a legitimate temporal view
  // a real client wants control over (a "past events" tab is normal for
  // an events app), so routes/events.ts lets the public route's caller
  // opt out of this default too, rather than hard-coding it the way
  // isActive is hard-coded for stations.
  upcomingOnly?: boolean;
  // Step 30: proximity search. nearLatitude/nearLongitude must be given
  // together (routes/events.ts validates that cross-field rule before
  // this function is ever called) to filter to events that have their own
  // coordinates and, if radiusKm is given, are within that great-circle
  // distance - and to switch the result ordering to nearest-first instead
  // of the usual soonest-first. radiusKm alone (no center point) is
  // meaningless and is likewise rejected by the route before reaching here.
  nearLatitude?: number;
  nearLongitude?: number;
  radiusKm?: number;
  limit?: number;
  offset?: number;
}

export interface EventListResult {
  events: Event[];
  total: number;
}

export async function listEvents(filter: EventListFilter = {}): Promise<EventListResult> {
  const conditions: string[] = [];
  const values: unknown[] = [];
  let distanceExprSql = "NULL::double precision";
  let orderBySql = "e.starts_at ASC";

  if (filter.countryId !== undefined) {
    values.push(filter.countryId);
    conditions.push(`e.country_id = $${values.length}`);
  }
  if (filter.status !== undefined) {
    values.push(filter.status);
    conditions.push(`e.status = $${values.length}`);
  }
  if (filter.categoryId !== undefined) {
    values.push(filter.categoryId);
    conditions.push(
      `EXISTS (SELECT 1 FROM event_category_assignments eca WHERE eca.event_id = e.id AND eca.category_id = $${values.length})`,
    );
  }
  if (filter.search !== undefined && filter.search.trim() !== "") {
    values.push(`%${escapeLikePattern(filter.search.trim())}%`);
    conditions.push(`e.title ILIKE $${values.length}`);
  }
  if (filter.startsAfter !== undefined) {
    values.push(filter.startsAfter);
    conditions.push(`e.starts_at >= $${values.length}`);
  }
  if (filter.startsBefore !== undefined) {
    values.push(filter.startsBefore);
    conditions.push(`e.starts_at <= $${values.length}`);
  }
  if (filter.upcomingOnly === true) {
    // An event with no announced end time is judged by its start alone -
    // the same COALESCE(ends_at, starts_at) reasoning already applied by
    // the events_ends_at_after_starts_at CHECK constraint's own comment:
    // an event is "over" once its end (or, lacking one, its start) has
    // passed.
    conditions.push("COALESCE(e.ends_at, e.starts_at) >= now()");
  }
  if (filter.nearLatitude !== undefined && filter.nearLongitude !== undefined) {
    values.push(filter.nearLatitude);
    const latPlaceholder = `$${values.length}`;
    values.push(filter.nearLongitude);
    const lngPlaceholder = `$${values.length}`;
    // Haversine great-circle distance in kilometers - no PostGIS extension
    // needed for a "how far is this event" figure, only real trigonometry.
    // Clamped into [-1, 1] before acos(): floating-point rounding can push
    // the cosine sum fractionally outside that domain for two very close
    // or near-antipodal points, which would otherwise make acos() return
    // NaN instead of ~0.
    distanceExprSql = `(6371 * acos(LEAST(1, GREATEST(-1,
      cos(radians(${latPlaceholder})) * cos(radians(e.latitude)) * cos(radians(e.longitude) - radians(${lngPlaceholder}))
      + sin(radians(${latPlaceholder})) * sin(radians(e.latitude))
    ))))`;
    // Only events with their own coordinates can have a distance computed
    // at all - one lacking them is neither included nor excluded by
    // radiusKm, it's simply not a candidate for a proximity search.
    conditions.push("e.latitude IS NOT NULL AND e.longitude IS NOT NULL");
    if (filter.radiusKm !== undefined) {
      values.push(filter.radiusKm);
      conditions.push(`${distanceExprSql} <= $${values.length}`);
    }
    // Nearest-first, not soonest-first - a proximity search's entire point
    // is "what's closest," the same way GET /v1/stations/ranked's entire
    // point is "what's most reliable," each overriding this listing's
    // otherwise-default sort for the specific view it's answering.
    orderBySql = `${distanceExprSql} ASC`;
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  const limit = Math.min(Math.max(filter.limit ?? DEFAULT_EVENT_LIST_LIMIT, 1), MAX_EVENT_LIST_LIMIT);
  const offset = Math.max(filter.offset ?? 0, 0);
  values.push(limit);
  const limitPlaceholder = `$${values.length}`;
  values.push(offset);
  const offsetPlaceholder = `$${values.length}`;

  // Soonest-first by default: an events listing is a "what's coming up"
  // view, not an alphabetical catalog like stations - starts_at ASC is the
  // ordering callers actually want, both publicly and in the admin
  // moderation queue, unless a proximity search overrides it above.
  const result = await query<EventRow>(
    `${buildEventSelect(distanceExprSql)} ${where} ORDER BY ${orderBySql} LIMIT ${limitPlaceholder} OFFSET ${offsetPlaceholder}`,
    values,
  );
  const total = result.rows[0] ? Number(result.rows[0].total_count) : 0;
  return { events: result.rows.map(toEvent), total };
}

export async function findEventById(id: number): Promise<Event | null> {
  const result = await query<EventRow>(`${EVENT_SELECT} WHERE e.id = $1`, [id]);
  const row = result.rows[0];
  return row ? toEvent(row) : null;
}

// Step 51: bulk-hydrates full Event objects (categories included) for a set
// of ids in one round trip - favoritesRepository already knows *which*
// events and in *what order* (most-recently-favorited first) from its own
// junction-table query, so re-fetching one at a time via findEventById
// would be an avoidable N+1. The identical pattern and reasoning as
// stationsRepository.findStationsByIds: Postgres's ANY($1) makes no
// ordering guarantee, so the caller re-sorts these back into its own order.
export async function findEventsByIds(ids: number[]): Promise<Event[]> {
  if (ids.length === 0) return [];
  const result = await query<EventRow>(`${EVENT_SELECT} WHERE e.id = ANY($1)`, [ids]);
  return result.rows.map(toEvent);
}

export interface EventUpdate {
  countryId?: number;
  title?: string;
  description?: string | null;
  venue?: string | null;
  venueAddress?: string | null;
  // undefined on either = leave that field untouched; null on both =
  // clear the location entirely; a real number on both = set/replace it.
  // Setting only one of the pair (the other left undefined, still holding
  // its old value) can violate events_location_lat_long_together if the
  // row didn't already have a value for the untouched one - the database
  // is the authoritative enforcement (InvalidLocationError, 400), the
  // same "DB constraint as the real guarantee" reasoning as every other
  // CHECK in this schema.
  latitude?: number | null;
  longitude?: number | null;
  startsAt?: string;
  endsAt?: string | null;
  imageUrl?: string | null;
  ticketUrl?: string | null;
  status?: EventStatus;
  // Only meaningful together with status in the same update - the route
  // validates that combination before this function is ever called, the
  // same cross-field rule as StationUpdate.deactivationReason/isActive.
  moderationReason?: string;
  // undefined = leave associations untouched; [] = clear them; a
  // non-empty array = replace them with exactly this set - the same
  // convention as StationUpdate.genreIds/languageIds.
  categoryIds?: number[];
}

// actorUserId: the admin performing this write - recorded as
// moderated_by_user_id only when this call is the one that sets status.
// Unlike stationsRepository.updateStation's actorUserId, this is always a
// real admin id, never null: PATCH /v1/events/:id is unconditionally
// admin-gated (there's no automated/system actor for event moderation the
// way Step 23's stream-reliability monitor is one for stations), so every
// call site has a real id to pass.
export async function updateEvent(
  id: number,
  updates: EventUpdate,
  actorUserId: number,
): Promise<Event | null> {
  const setClauses: string[] = [];
  const values: unknown[] = [];

  if (updates.countryId !== undefined) {
    values.push(updates.countryId);
    setClauses.push(`country_id = $${values.length}`);
  }
  if (updates.title !== undefined) {
    values.push(updates.title);
    setClauses.push(`title = $${values.length}`);
    values.push(normalizeEventTitle(updates.title));
    setClauses.push(`title_normalized = $${values.length}`);
  }
  if (updates.description !== undefined) {
    values.push(updates.description);
    setClauses.push(`description = $${values.length}`);
  }
  if (updates.venue !== undefined) {
    values.push(updates.venue);
    setClauses.push(`venue = $${values.length}`);
  }
  if (updates.venueAddress !== undefined) {
    values.push(updates.venueAddress);
    setClauses.push(`venue_address = $${values.length}`);
  }
  if (updates.latitude !== undefined) {
    values.push(updates.latitude);
    setClauses.push(`latitude = $${values.length}`);
  }
  if (updates.longitude !== undefined) {
    values.push(updates.longitude);
    setClauses.push(`longitude = $${values.length}`);
  }
  if (updates.startsAt !== undefined) {
    values.push(updates.startsAt);
    setClauses.push(`starts_at = $${values.length}`);
  }
  if (updates.endsAt !== undefined) {
    values.push(updates.endsAt);
    setClauses.push(`ends_at = $${values.length}`);
  }
  if (updates.imageUrl !== undefined) {
    values.push(updates.imageUrl);
    setClauses.push(`image_url = $${values.length}`);
  }
  if (updates.ticketUrl !== undefined) {
    values.push(updates.ticketUrl);
    setClauses.push(`ticket_url = $${values.length}`);
  }
  if (updates.status !== undefined) {
    values.push(updates.status);
    setClauses.push(`status = $${values.length}`);
    // A status decision is a moderation decision - always recorded, not
    // scoped to only an approved->rejected/rejected->approved transition:
    // re-affirming an already-decided status is still an admin action
    // worth attributing, the identical reasoning as updateStation always
    // recording who flips isActive regardless of the row's previous value.
    values.push(actorUserId);
    setClauses.push(`moderated_by_user_id = $${values.length}`);
    setClauses.push("moderated_at = now()");
    values.push(updates.moderationReason ?? null);
    setClauses.push(`moderation_reason = $${values.length}`);
  }

  const touchesCategories = updates.categoryIds !== undefined;
  if (setClauses.length === 0 && !touchesCategories) {
    return findEventById(id);
  }

  try {
    await withTransaction(async (client) => {
      // Always runs - even a categories-only update bumps updated_at, and
      // the UPDATE's rowCount is also how a nonexistent event id gets
      // detected (a categories-only write against a missing id would
      // otherwise silently no-op instead of surfacing as "not found").
      setClauses.push("updated_at = now()");
      const result = await client.query(
        `UPDATE events SET ${setClauses.join(", ")} WHERE id = $${values.length + 1}`,
        [...values, id],
      );
      if ((result.rowCount ?? 0) === 0) {
        throw new EventNotFoundSentinel();
      }
      if (updates.categoryIds !== undefined) {
        await replaceEventCategories(client, id, updates.categoryIds);
      }
    });
  } catch (err) {
    if (err instanceof EventNotFoundSentinel) {
      return null;
    }
    throw toEventWriteError(err, updates.countryId);
  }

  return findEventById(id);
}

// Internal-only signal from inside the transaction ("the UPDATE matched
// zero rows") back out to updateEvent's null-return contract - the
// identical pattern as stationsRepository.StationNotFoundSentinel, never
// exported alongside the other error classes above.
class EventNotFoundSentinel extends Error {}

export async function deleteEvent(id: number): Promise<boolean> {
  return withTransaction(async (client) => {
    const result = await client.query("DELETE FROM events WHERE id = $1", [id]);
    return (result.rowCount ?? 0) > 0;
  });
}
