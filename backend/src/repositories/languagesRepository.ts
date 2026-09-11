import { query } from "../db/pool.js";

export interface Language {
  id: number;
  code: string;
  name: string;
}

export async function listLanguages(): Promise<Language[]> {
  const result = await query<Language>("SELECT id, code, name FROM languages ORDER BY name ASC");
  return result.rows;
}
