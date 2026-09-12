import { withTransaction } from "../db/transaction.js";
import { query } from "../db/pool.js";

export type EventStatus = "pending" | "approved" | "rejected";

export interface Event {
  id: number;
  countryId: number;
  title: string;
  description: string | null;
  venue: string | null;
  startsAt: string;
  endsAt: string | null;
  imageUrl: string | null;
  ticketUrl: string | null;
  status: EventStatus;
  createdByUserId: number | null;
  createdAt: string;
  updatedAt: string;
}

interface EventRow {
  id: number;
  country_id: number;
  title: string;
  description: string | null;
  venue: string | null;
  starts_at: string;
  ends_at: string | null;
  image_url: string | null;
  ticket_url: string | null;
  status: EventStatus;
  created_by_user_id: number | null;
  created_at: string;
  updated_at: string;
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

const FOREIGN_KEY_VIOLATION = "23503";
const CHECK_VIOLATION = "23514";
const ENDS_AT_CONSTRAINT = "events_ends_at_after_starts_at";

// Same COUNT(*) OVER() reasoning as stationsRepository.STATION_SELECT - the
// filtered-but-unpaginated total in one round trip, harmless overhead on the
// single-row lookups (findEventById) that also use this base query.
const EVENT_SELECT = `
  SELECT
    id, country_id, title, description, venue, starts_at, ends_at,
    image_url, ticket_url, status, created_by_user_id, created_at, updated_at,
    COUNT(*) OVER() AS total_count
  FROM events
`;

function toEvent(row: EventRow): Event {
  return {
    id: row.id,
    countryId: row.country_id,
    title: row.title,
    description: row.description,
    venue: row.venue,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    imageUrl: row.image_url,
    ticketUrl: row.ticket_url,
    status: row.status,
    createdByUserId: row.created_by_user_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toEventWriteError(err: unknown, countryId?: number): unknown {
  if (hasPgErrorCode(err, FOREIGN_KEY_VIOLATION) && countryId !== undefined) {
    return new InvalidCountryError(countryId);
  }
  if (hasPgErrorCode(err, CHECK_VIOLATION) && pgConstraintName(err) === ENDS_AT_CONSTRAINT) {
    return new InvalidEndsAtError();
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

export interface NewEvent {
  countryId: number;
  title: string;
  description?: string | null;
  venue?: string | null;
  startsAt: string;
  endsAt?: string | null;
  imageUrl?: string | null;
  ticketUrl?: string | null;
  // Never client-supplied - see routes/events.ts for exactly how this is
  // derived from the submitter's role (admin -> 'approved', regular user ->
  // 'pending').
  status: EventStatus;
  createdByUserId?: number | null;
}

export async function createEvent(input: NewEvent): Promise<Event> {
  let newId: number;
  try {
    newId = await withTransaction(async (client) => {
      const result = await client.query<{ id: number }>(
        `INSERT INTO events
           (country_id, title, description, venue, starts_at, ends_at, image_url, ticket_url, status, created_by_user_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         RETURNING id`,
        [
          input.countryId,
          input.title,
          input.description ?? null,
          input.venue ?? null,
          input.startsAt,
          input.endsAt ?? null,
          input.imageUrl ?? null,
          input.ticketUrl ?? null,
          input.status,
          input.createdByUserId ?? null,
        ],
      );
      return result.rows[0].id;
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
  // Tri-state, the same "undefined means no filter" convention as
  // StationListFilter.isActive: the public route (routes/events.ts) always
  // passes 'approved' explicitly; the admin moderation queue leaves this
  // undefined to see every status, or filters to exactly one.
  status?: EventStatus;
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

  if (filter.countryId !== undefined) {
    values.push(filter.countryId);
    conditions.push(`country_id = $${values.length}`);
  }
  if (filter.status !== undefined) {
    values.push(filter.status);
    conditions.push(`status = $${values.length}`);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  const limit = Math.min(Math.max(filter.limit ?? DEFAULT_EVENT_LIST_LIMIT, 1), MAX_EVENT_LIST_LIMIT);
  const offset = Math.max(filter.offset ?? 0, 0);
  values.push(limit);
  const limitPlaceholder = `$${values.length}`;
  values.push(offset);
  const offsetPlaceholder = `$${values.length}`;

  // Soonest-first: an events listing is a "what's coming up" view, not an
  // alphabetical catalog like stations - starts_at ASC is the ordering
  // callers actually want, both publicly and in the admin moderation queue.
  const result = await query<EventRow>(
    `${EVENT_SELECT} ${where} ORDER BY starts_at ASC LIMIT ${limitPlaceholder} OFFSET ${offsetPlaceholder}`,
    values,
  );
  const total = result.rows[0] ? Number(result.rows[0].total_count) : 0;
  return { events: result.rows.map(toEvent), total };
}

export async function findEventById(id: number): Promise<Event | null> {
  const result = await query<EventRow>(`${EVENT_SELECT} WHERE id = $1`, [id]);
  const row = result.rows[0];
  return row ? toEvent(row) : null;
}

export interface EventUpdate {
  countryId?: number;
  title?: string;
  description?: string | null;
  venue?: string | null;
  startsAt?: string;
  endsAt?: string | null;
  imageUrl?: string | null;
  ticketUrl?: string | null;
  status?: EventStatus;
}

export async function updateEvent(id: number, updates: EventUpdate): Promise<Event | null> {
  const setClauses: string[] = [];
  const values: unknown[] = [];

  if (updates.countryId !== undefined) {
    values.push(updates.countryId);
    setClauses.push(`country_id = $${values.length}`);
  }
  if (updates.title !== undefined) {
    values.push(updates.title);
    setClauses.push(`title = $${values.length}`);
  }
  if (updates.description !== undefined) {
    values.push(updates.description);
    setClauses.push(`description = $${values.length}`);
  }
  if (updates.venue !== undefined) {
    values.push(updates.venue);
    setClauses.push(`venue = $${values.length}`);
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
  }

  if (setClauses.length === 0) {
    return findEventById(id);
  }

  try {
    setClauses.push("updated_at = now()");
    const result = await query(
      `UPDATE events SET ${setClauses.join(", ")} WHERE id = $${values.length + 1}`,
      [...values, id],
    );
    if ((result.rowCount ?? 0) === 0) {
      return null;
    }
  } catch (err) {
    throw toEventWriteError(err, updates.countryId);
  }

  return findEventById(id);
}

export async function deleteEvent(id: number): Promise<boolean> {
  return withTransaction(async (client) => {
    const result = await client.query("DELETE FROM events WHERE id = $1", [id]);
    return (result.rowCount ?? 0) > 0;
  });
}
