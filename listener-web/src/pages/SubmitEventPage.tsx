import { useState } from "react";
import type { FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { submitEvent } from "../api/events";
import { listEventCategories } from "../api/lookups";
import { ApiError } from "../api/client";
import { CountrySelect } from "../components/CountrySelect";

const inputClass =
  "w-full rounded-lg border border-ocean-200 bg-white px-3 py-2 text-sm text-ocean-900 transition focus:outline-none focus-visible:ring-2 focus-visible:ring-ocean-500";
const labelClass = "block text-sm font-semibold text-ocean-800";

// POST /v1/events (backend/src/routes/events.ts) requires only
// authentication, not admin - a submission starts in the moderation
// queue (status: "pending") until an admin approves it, so it won't
// appear on GET /v1/events (which only returns approved) until then.
// That's the real, honest behavior - this page says so rather than
// implying the event goes live immediately.
export function SubmitEventPage() {
  const navigate = useNavigate();
  const { data: categoriesData } = useQuery({
    queryKey: ["event-categories"],
    queryFn: listEventCategories,
    staleTime: 60_000,
  });
  const categories = categoriesData?.categories ?? [];

  const [countryId, setCountryId] = useState<number | null>(null);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [venue, setVenue] = useState("");
  const [startsAt, setStartsAt] = useState("");
  const [ticketUrl, setTicketUrl] = useState("");
  const [categoryIds, setCategoryIds] = useState<number[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submittedEventId, setSubmittedEventId] = useState<number | null>(null);

  function toggleCategory(id: number) {
    setCategoryIds((prev) => (prev.includes(id) ? prev.filter((c) => c !== id) : [...prev, id]));
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    if (!countryId) {
      setError("Please select a country.");
      return;
    }
    setSubmitting(true);
    try {
      const created = await submitEvent({
        countryId,
        title,
        description: description || undefined,
        venue: venue || undefined,
        startsAt: new Date(startsAt).toISOString(),
        ticketUrl: ticketUrl || undefined,
        categoryIds: categoryIds.length > 0 ? categoryIds : undefined,
      });
      setSubmittedEventId(created.id);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Something went wrong. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  if (submittedEventId !== null) {
    return (
      <div className="mx-auto max-w-lg space-y-4">
        <h1 className="text-2xl font-bold text-ocean-900">Event submitted</h1>
        <p className="text-ocean-700">
          Thanks — your event has been submitted and is awaiting review. It will appear on the Events page once
          an admin approves it.
        </p>
        <button
          type="button"
          onClick={() => navigate("/events")}
          className="rounded-full bg-ocean-700 px-5 py-2 text-sm font-semibold text-white transition hover:bg-ocean-600"
        >
          Back to Events
        </button>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-lg space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-ocean-900">Submit an event</h1>
        <p className="mt-1 text-sm text-ocean-600">
          Submitted events are reviewed by an admin before appearing publicly.
        </p>
      </div>
      <form onSubmit={handleSubmit} className="space-y-4" noValidate>
        <div>
          <label htmlFor="title" className={labelClass}>
            Title
          </label>
          <input
            id="title"
            type="text"
            required
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            className={inputClass}
          />
        </div>
        <div>
          <span className={labelClass}>Country</span>
          <div className="mt-1">
            <CountrySelect countryId={countryId} onChange={setCountryId} />
          </div>
        </div>
        <div>
          <label htmlFor="startsAt" className={labelClass}>
            Starts at
          </label>
          <input
            id="startsAt"
            type="datetime-local"
            required
            value={startsAt}
            onChange={(event) => setStartsAt(event.target.value)}
            className={inputClass}
          />
        </div>
        <div>
          <label htmlFor="venue" className={labelClass}>
            Venue (optional)
          </label>
          <input
            id="venue"
            type="text"
            value={venue}
            onChange={(event) => setVenue(event.target.value)}
            className={inputClass}
          />
        </div>
        <div>
          <label htmlFor="description" className={labelClass}>
            Description (optional)
          </label>
          <textarea
            id="description"
            rows={3}
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            className={inputClass}
          />
        </div>
        <div>
          <label htmlFor="ticketUrl" className={labelClass}>
            Ticket URL (optional)
          </label>
          <input
            id="ticketUrl"
            type="url"
            placeholder="https://…"
            value={ticketUrl}
            onChange={(event) => setTicketUrl(event.target.value)}
            className={inputClass}
          />
        </div>
        {categories.length > 0 && (
          <div>
            <span className={labelClass}>Categories (optional)</span>
            <div className="mt-1 flex flex-wrap gap-2">
              {categories.map((category) => (
                <button
                  key={category.id}
                  type="button"
                  onClick={() => toggleCategory(category.id)}
                  aria-pressed={categoryIds.includes(category.id)}
                  className={`rounded-full px-3 py-1 text-xs font-semibold transition ${
                    categoryIds.includes(category.id)
                      ? "bg-sunset-600 text-white"
                      : "bg-sunset-50 text-sunset-600 hover:bg-sunset-100"
                  }`}
                >
                  {category.name}
                </button>
              ))}
            </div>
          </div>
        )}
        {error && (
          <p role="alert" className="text-sm font-medium text-sunset-600">
            {error}
          </p>
        )}
        <button
          type="submit"
          disabled={submitting}
          className="rounded-full bg-ocean-700 px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-ocean-600 disabled:opacity-60"
        >
          {submitting ? "Submitting…" : "Submit event"}
        </button>
      </form>
    </div>
  );
}
