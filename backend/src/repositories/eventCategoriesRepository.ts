import { query } from "../db/pool.js";

export interface EventCategory {
  id: number;
  name: string;
}

export async function listEventCategories(): Promise<EventCategory[]> {
  const result = await query<EventCategory>("SELECT id, name FROM event_categories ORDER BY name ASC");
  return result.rows;
}
