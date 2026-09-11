import { query } from "../db/pool.js";

export interface Country {
  id: number;
  code: string;
  name: string;
  isActive: boolean;
}

interface CountryRow {
  id: number;
  code: string;
  name: string;
  is_active: boolean;
}

export async function listActiveCountries(): Promise<Country[]> {
  const result = await query<CountryRow>(
    "SELECT id, code, name, is_active FROM countries WHERE is_active = true ORDER BY name ASC",
  );
  return result.rows.map((row) => ({
    id: row.id,
    code: row.code,
    name: row.name,
    isActive: row.is_active,
  }));
}
