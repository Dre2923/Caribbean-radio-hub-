import { query } from "../db/pool.js";

export interface Genre {
  id: number;
  name: string;
}

export async function listGenres(): Promise<Genre[]> {
  const result = await query<Genre>("SELECT id, name FROM genres ORDER BY name ASC");
  return result.rows;
}
