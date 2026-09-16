import { useState } from "react";
import type { FormEvent } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { confirmPasswordReset, requestPasswordReset } from "../api/auth";
import { ApiError } from "../api/client";

const inputClass =
  "w-full rounded-lg border border-ocean-200 bg-white px-3 py-2 text-sm text-ocean-900 transition focus:outline-none focus-visible:ring-2 focus-visible:ring-ocean-500";
const labelClass = "block text-sm font-semibold text-ocean-800";

// POST /v1/auth/password-reset/request always returns the same 200
// regardless of whether the email is registered (anti-enumeration - see
// backend/src/routes/auth.ts's own comment). This page reflects that
// honestly: it never claims "email sent" as a fact this client can
// verify, just the same neutral message the backend itself returns.
function RequestResetForm() {
  const [email, setEmail] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    try {
      const response = await requestPasswordReset(email);
      setMessage(response.message);
    } catch {
      setMessage("Something went wrong. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
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
      {message && (
        <p role="status" className="text-sm font-medium text-ocean-700">
          {message}
        </p>
      )}
      <button
        type="submit"
        disabled={submitting}
        className="w-full rounded-full bg-ocean-700 px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-ocean-600 disabled:opacity-60"
      >
        {submitting ? "Sending…" : "Send reset link"}
      </button>
    </form>
  );
}

function ConfirmResetForm({ token }: { token: string }) {
  const navigate = useNavigate();
  const [newPassword, setNewPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await confirmPasswordReset(token, newPassword);
      navigate("/login", { replace: true, state: { resetComplete: true } });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Something went wrong. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4" noValidate>
      <div>
        <label htmlFor="newPassword" className={labelClass}>
          New password
        </label>
        <input
          id="newPassword"
          type="password"
          autoComplete="new-password"
          required
          minLength={8}
          value={newPassword}
          onChange={(event) => setNewPassword(event.target.value)}
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
        {submitting ? "Resetting…" : "Reset password"}
      </button>
    </form>
  );
}

export function ForgotPasswordPage() {
  const [searchParams] = useSearchParams();
  const token = searchParams.get("token");

  return (
    <div className="mx-auto max-w-sm space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-ocean-900">
          {token ? "Choose a new password" : "Reset your password"}
        </h1>
        {!token && (
          <p className="mt-1 text-sm text-ocean-600">
            Enter your email and, if it&apos;s registered, we&apos;ll send a reset link.
          </p>
        )}
      </div>
      {token ? <ConfirmResetForm token={token} /> : <RequestResetForm />}
      <p className="text-sm text-ocean-600">
        <Link to="/login" className="text-ocean-700 underline hover:text-ocean-800">
          Back to sign in
        </Link>
      </p>
    </div>
  );
}
