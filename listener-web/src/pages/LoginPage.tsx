import { useState } from "react";
import type { FormEvent } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "../auth/useAuth";
import { ApiError } from "../api/client";

const inputClass =
  "w-full rounded-lg border border-ocean-200 bg-white px-3 py-2 text-sm text-ocean-900 transition focus:outline-none focus-visible:ring-2 focus-visible:ring-ocean-500";
const labelClass = "block text-sm font-semibold text-ocean-800";

export function LoginPage() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const from = (location.state as { from?: { pathname: string } } | null)?.from?.pathname ?? "/";

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await login(email, password);
      navigate(from, { replace: true });
    } catch (err) {
      // backend/src/routes/auth.ts's own login handler returns the
      // identical 401 "Invalid email or password" whether the email is
      // unregistered or the password is wrong - this client surfaces
      // that exact message rather than guessing a more specific one.
      setError(err instanceof ApiError ? err.message : "Something went wrong. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="mx-auto max-w-sm space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-ocean-900">Sign in</h1>
        <p className="mt-1 text-sm text-ocean-600">
          Sign in to favorite stations and events, track your listening history, and more.
        </p>
      </div>
      <form onSubmit={handleSubmit} className="space-y-4" noValidate>
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
            autoComplete="current-password"
            required
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            className={inputClass}
          />
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
          {submitting ? "Signing in…" : "Sign in"}
        </button>
      </form>
      <div className="flex justify-between text-sm">
        <Link to="/forgot-password" className="text-ocean-600 underline hover:text-ocean-700">
          Forgot password?
        </Link>
        <Link to="/register" className="text-ocean-600 underline hover:text-ocean-700">
          Create an account
        </Link>
      </div>
    </div>
  );
}
