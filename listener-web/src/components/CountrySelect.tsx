import { useQuery } from "@tanstack/react-query";
import { listCountries } from "../api/lookups";

export function CountrySelect({
  countryId,
  onChange,
}: {
  countryId: number | null;
  onChange: (id: number) => void;
}) {
  const { data } = useQuery({ queryKey: ["countries"], queryFn: listCountries, staleTime: 60_000 });
  const countries = data?.countries ?? [];

  return (
    <select
      value={countryId ?? ""}
      onChange={(event) => onChange(Number(event.target.value))}
      className="rounded-lg border border-ocean-200 bg-white px-3 py-2 text-sm font-medium text-ocean-900 transition hover:border-ocean-400 focus:outline-none focus-visible:ring-2 focus-visible:ring-ocean-500"
      aria-label="Select country"
    >
      {countries.length === 0 && <option value="">Loading countries…</option>}
      {countries.map((country) => (
        <option key={country.id} value={country.id}>
          {country.name}
        </option>
      ))}
    </select>
  );
}
