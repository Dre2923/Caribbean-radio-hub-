import { useState } from "react";
import type { FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { changePassword, deleteAccount, updateProfile } from "../api/auth";
import { getNotificationPreferences, updateNotificationPreferences } from "../api/notificationPreferences";
import { useAuth } from "../auth/useAuth";
import { ApiError } from "../api/client";
import { CountrySelect } from "../components/CountrySelect";

const inputClass =
  "w-full rounded-lg border border-ocean-200 bg-white px-3 py-2 text-sm text-ocean-900 transition focus:outline-none focus-visible:ring-2 focus-visible:ring-ocean-500";
const labelClass = "block text-sm font-semibold text-ocean-800";
const sectionClass = "rounded-xl border border-ocean-100 bg-white p-5 shadow-sm";

function ProfileDetailsSection() {
  const { user, refreshUser } = useAuth();
  const [displayName, setDisplayName] = useState(user?.displayName ?? "");
  const [countryId, setCountryId] = useState<number | null>(user?.countryId ?? null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setMessage(null);
    setSubmitting(true);
    try {
      await updateProfile({ displayName, countryId });
      await refreshUser();
      setMessage("Profile updated.");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Something went wrong. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section className={sectionClass}>
      <h2 className="text-lg font-semibold text-ocean-900">Profile</h2>
      <p className="mt-1 text-sm text-ocean-500">Signed in as {user?.email}</p>
      <form onSubmit={handleSubmit} className="mt-4 space-y-4" noValidate>
        <div>
          <label htmlFor="displayName" className={labelClass}>
            Name
          </label>
          <input
            id="displayName"
            type="text"
            value={displayName}
            onChange={(event) => setDisplayName(event.target.value)}
            className={inputClass}
          />
        </div>
        <div>
          <span className={labelClass}>Country</span>
          <div className="mt-1">
            <CountrySelect countryId={countryId} onChange={setCountryId} />
          </div>
        </div>
        {message && <p className="text-sm font-medium text-success-700">{message}</p>}
        {error && (
          <p role="alert" className="text-sm font-medium text-sunset-600">
            {error}
          </p>
        )}
        <button
          type="submit"
          disabled={submitting}
          className="rounded-full bg-ocean-700 px-5 py-2 text-sm font-semibold text-white transition hover:bg-ocean-600 disabled:opacity-60"
        >
          {submitting ? "Saving…" : "Save changes"}
        </button>
      </form>
    </section>
  );
}

function NotificationPreferencesSection() {
  const queryClient = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ["notification-preferences"],
    queryFn: getNotificationPreferences,
  });

  const update = useMutation({
    mutationFn: updateNotificationPreferences,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["notification-preferences"] }),
  });

  return (
    <section className={sectionClass}>
      <h2 className="text-lg font-semibold text-ocean-900">Notification preferences</h2>
      <p className="mt-1 text-sm text-ocean-500">
        These control whether the mobile app would send you push notifications. This browser tab can&apos;t
        receive push notifications itself — this only sets the real, stored preference.
      </p>
      {isLoading && <p className="mt-3 text-sm text-ocean-600">Loading…</p>}
      {data && (
        <div className="mt-4 space-y-3">
          <label className="flex items-center gap-3 text-sm text-ocean-800">
            <input
              type="checkbox"
              checked={data.favoriteStationAvailabilityChanges}
              onChange={(event) =>
                update.mutate({ favoriteStationAvailabilityChanges: event.target.checked })
              }
              className="h-4 w-4 rounded border-ocean-300 text-ocean-600 focus:ring-ocean-500"
            />
            Notify me when a favorited station&apos;s availability changes
          </label>
          <label className="flex items-center gap-3 text-sm text-ocean-800">
            <input
              type="checkbox"
              checked={data.weeklyEventsDigest}
              onChange={(event) => update.mutate({ weeklyEventsDigest: event.target.checked })}
              className="h-4 w-4 rounded border-ocean-300 text-ocean-600 focus:ring-ocean-500"
            />
            Send me a weekly digest of upcoming events in my country
          </label>
        </div>
      )}
    </section>
  );
}

function ChangePasswordSection() {
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setMessage(null);
    setSubmitting(true);
    try {
      await changePassword(currentPassword, newPassword);
      setCurrentPassword("");
      setNewPassword("");
      setMessage("Password changed.");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Something went wrong. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section className={sectionClass}>
      <h2 className="text-lg font-semibold text-ocean-900">Change password</h2>
      <form onSubmit={handleSubmit} className="mt-4 space-y-4" noValidate>
        <div>
          <label htmlFor="currentPassword" className={labelClass}>
            Current password
          </label>
          <input
            id="currentPassword"
            type="password"
            autoComplete="current-password"
            required
            value={currentPassword}
            onChange={(event) => setCurrentPassword(event.target.value)}
            className={inputClass}
          />
        </div>
        <div>
          <label htmlFor="newPassword2" className={labelClass}>
            New password
          </label>
          <input
            id="newPassword2"
            type="password"
            autoComplete="new-password"
            required
            minLength={8}
            value={newPassword}
            onChange={(event) => setNewPassword(event.target.value)}
            className={inputClass}
          />
        </div>
        {message && <p className="text-sm font-medium text-success-700">{message}</p>}
        {error && (
          <p role="alert" className="text-sm font-medium text-sunset-600">
            {error}
          </p>
        )}
        <button
          type="submit"
          disabled={submitting}
          className="rounded-full bg-ocean-700 px-5 py-2 text-sm font-semibold text-white transition hover:bg-ocean-600 disabled:opacity-60"
        >
          {submitting ? "Changing…" : "Change password"}
        </button>
      </form>
    </section>
  );
}

function DeleteAccountSection() {
  const { logout } = useAuth();
  const navigate = useNavigate();
  const [confirming, setConfirming] = useState(false);
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await deleteAccount(password);
      logout();
      navigate("/", { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Something went wrong. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section className={`${sectionClass} border-sunset-100`}>
      <h2 className="text-lg font-semibold text-sunset-600">Delete account</h2>
      <p className="mt-1 text-sm text-ocean-500">This permanently deletes your account. This cannot be undone.</p>
      {!confirming ? (
        <button
          type="button"
          onClick={() => setConfirming(true)}
          className="mt-4 rounded-full border border-sunset-300 px-5 py-2 text-sm font-semibold text-sunset-600 transition hover:bg-sunset-50"
        >
          Delete my account
        </button>
      ) : (
        <form onSubmit={handleSubmit} className="mt-4 space-y-4" noValidate>
          <div>
            <label htmlFor="deletePassword" className={labelClass}>
              Confirm your password
            </label>
            <input
              id="deletePassword"
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
          <div className="flex gap-2">
            <button
              type="submit"
              disabled={submitting}
              className="rounded-full bg-sunset-600 px-5 py-2 text-sm font-semibold text-white transition hover:bg-sunset-500 disabled:opacity-60"
            >
              {submitting ? "Deleting…" : "Permanently delete"}
            </button>
            <button
              type="button"
              onClick={() => setConfirming(false)}
              className="rounded-full border border-ocean-200 px-5 py-2 text-sm font-semibold text-ocean-700 hover:bg-ocean-50"
            >
              Cancel
            </button>
          </div>
        </form>
      )}
    </section>
  );
}

export function ProfilePage() {
  return (
    <div className="mx-auto max-w-lg space-y-6">
      <h1 className="text-2xl font-bold text-ocean-900">Your account</h1>
      <ProfileDetailsSection />
      <NotificationPreferencesSection />
      <ChangePasswordSection />
      <DeleteAccountSection />
    </div>
  );
}
