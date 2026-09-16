import { useState } from "react";
import type { FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { register } from "../api/auth";
import { useAuth } from "../auth/useAuth";
import { ApiError } from "../api/client";
import { CountrySelect } from "../components/CountrySelect";

const inputClass =
  "w-full rounded-lg border border-ocean-200 bg-white px-3 py-2 text-sm text-ocean-900 transition focus:outline-none focus-visible:ring-2 focus-visible:ring-ocean-500";
const labelClass = "block text-sm font-semibold text-ocean-800";

export function RegisterPage() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const [displayName, setDisplayName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [countryId, setCountryId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await register({ email, password, displayName, countryId: countryId ?? undefined });
      // POST /v1/users returns only the created user, no token
      // (backend/src/routes/users.ts) - registration and login are
      // separate real endpoints. Signing in immediately with the same
      // credentials just entered is the honest, real way to give a
      // "create account" flow a single-step feel without inventing a
      // combined endpoint the backend doesn't have.
      await login(email, password);
      navigate("/", { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Something went wrong. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="mx-auto max-w-sm space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-ocean-900">Create your account</h1>
        <p className="mt-1 text-sm text-ocean-600">Free, and takes less than a minute.</p>
      </div>
      <form onSubmit={handleSubmit} className="space-y-4" noValidate>
        <div>
          <label htmlFor="displayName" className={labelClass}>
            Name
          </label>
          <input
            id="displayName"
            type="text"
            autoComplete="name"
            required
            value={displayName}
            onChange={(event) => setDisplayName(event.target.value)}
            className={inputClass}
          />
        </div>
        <div>
          <label htmlFor="email" className={labelClass}>
            Email
          </label>
          <input
            id="email"
            type="email"
            autoComplete="email"
            required
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            className={inputClass}
          />
        </div>
        <div>
          <label htmlFor="password" className={labelClass}>
            Password
          </label>
          <input
            id="password"
            type="password"
            autoComplete="new-password"
            required
            minLength={8}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            className={inputClass}
          />
        </div>
        <div>
          <span className={labelClass}>Country (optional)</span>
          <div className="mt-1">
            <CountrySelect countryId={countryId} onChange={setCountryId} />
          </div>
        </div>
        {error && (
          <p role="alert" className="text-sm font-medium text-sunset-600">
            {error}
          </p>
        )}
        <button
          type="submit"
          disabled={submitting}
          className="w-full rounded-full bg-ocean-700 px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-ocean-600 disabled:opacity-60"
        >
          {submitting ? "Creating account…" : "Create account"}
        </button>
      </form>
      <p className="text-sm text-ocean-600">
        Already have an account?{" "}
        <Link to="/login" className="text-ocean-700 underline hover:text-ocean-800">
          Sign in
        </Link>
      </p>
    </div>
  );
}
