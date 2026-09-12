import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { listUsers, updateUserRole } from "../api/users";
import { ApiError } from "../api/client";
import { useDebouncedValue } from "../hooks/useDebouncedValue";
import { RoleBadge } from "../components/RoleBadge";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { useAuth } from "../auth/useAuth";
import type { AdminUser, UserRole } from "../api/types";

const PAGE_SIZE = 20;

type RoleFilter = "all" | UserRole;

interface PendingRoleChange {
  user: AdminUser;
  nextRole: UserRole;
}

function formatDate(value: string | null): string {
  if (!value) return "—";
  return new Date(value).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

export function UsersPage() {
  const { user: currentUser } = useAuth();
  const queryClient = useQueryClient();
  const [searchInput, setSearchInput] = useState("");
  const [roleFilter, setRoleFilter] = useState<RoleFilter>("all");
  const [offset, setOffset] = useState(0);
  const [pending, setPending] = useState<PendingRoleChange | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const search = useDebouncedValue(searchInput, 300);

  const queryParams = useMemo(
    () => ({
      q: search.trim() || undefined,
      role: roleFilter === "all" ? undefined : roleFilter,
      limit: PAGE_SIZE,
      offset,
    }),
    [search, roleFilter, offset],
  );

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ["admin-users", queryParams],
    queryFn: () => listUsers(queryParams),
    placeholderData: (previous) => previous,
  });

  const mutation = useMutation({
    mutationFn: ({ user, nextRole }: PendingRoleChange) => updateUserRole(user.id, nextRole),
    onSuccess: () => {
      setPending(null);
      setActionError(null);
      void queryClient.invalidateQueries({ queryKey: ["admin-users"] });
    },
    onError: (err: unknown) => {
      setActionError(err instanceof ApiError ? err.message : "Failed to update role.");
    },
  });

  function requestRoleChange(user: AdminUser, nextRole: UserRole) {
    setActionError(null);
    setPending({ user, nextRole });
  }

  function handleSearchChange(value: string) {
    setSearchInput(value);
    setOffset(0);
  }

  function handleRoleFilterChange(value: RoleFilter) {
    setRoleFilter(value);
    setOffset(0);
  }

  const total = data?.pagination.total ?? 0;
  const rangeStart = total === 0 ? 0 : offset + 1;
  const rangeEnd = Math.min(offset + PAGE_SIZE, total);

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-xl font-semibold tracking-tight text-slate-900">Users</h1>
        <p className="mt-1 text-sm text-slate-500">
          Search accounts and manage admin access. Changing the last remaining admin's role is
          blocked by the API to prevent a permanent lockout.
        </p>
      </div>

      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <input
          type="search"
          value={searchInput}
          onChange={(event) => handleSearchChange(event.target.value)}
          placeholder="Search by email or name…"
          className="w-full max-w-sm rounded-md border border-slate-300 px-3 py-2 text-sm shadow-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
        />
        <div className="flex gap-1 rounded-md bg-slate-100 p-1">
          {(["all", "user", "admin"] as const).map((option) => (
            <button
              key={option}
              type="button"
              onClick={() => handleRoleFilterChange(option)}
              className={
                "rounded px-3 py-1 text-sm font-medium capitalize transition-colors " +
                (roleFilter === option ? "bg-white text-slate-900 shadow-sm" : "text-slate-500 hover:text-slate-700")
              }
            >
              {option}
            </button>
          ))}
        </div>
      </div>

      {actionError && (
        <p role="alert" className="mb-4 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
          {actionError}
        </p>
      )}

      <div className="overflow-hidden rounded-xl bg-white shadow-sm ring-1 ring-slate-200">
        <table className="min-w-full divide-y divide-slate-200 text-sm">
          <thead className="bg-slate-50">
            <tr>
              <th scope="col" className="px-4 py-3 text-left font-medium text-slate-500">
                Account
              </th>
              <th scope="col" className="px-4 py-3 text-left font-medium text-slate-500">
                Role
              </th>
              <th scope="col" className="px-4 py-3 text-left font-medium text-slate-500">
                Role last changed
              </th>
              <th scope="col" className="px-4 py-3 text-right font-medium text-slate-500">
                Actions
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {isLoading && (
              <tr>
                <td colSpan={4} className="px-4 py-8 text-center text-slate-400">
                  Loading users…
                </td>
              </tr>
            )}
            {isError && (
              <tr>
                <td colSpan={4} className="px-4 py-8 text-center text-red-600">
                  {error instanceof ApiError ? error.message : "Failed to load users."}
                </td>
              </tr>
            )}
            {!isLoading && !isError && data?.users.length === 0 && (
              <tr>
                <td colSpan={4} className="px-4 py-8 text-center text-slate-400">
                  No users match this filter.
                </td>
              </tr>
            )}
            {data?.users.map((user) => {
              const nextRole: UserRole = user.role === "admin" ? "user" : "admin";
              const isSelf = user.id === currentUser?.id;
              return (
                <tr key={user.id}>
                  <td className="px-4 py-3">
                    <div className="font-medium text-slate-900">{user.displayName}</div>
                    <div className="text-slate-500">{user.email}</div>
                  </td>
                  <td className="px-4 py-3">
                    <RoleBadge role={user.role} />
                  </td>
                  <td className="px-4 py-3 text-slate-500">{formatDate(user.roleChangedAt)}</td>
                  <td className="px-4 py-3 text-right">
                    <button
                      type="button"
                      onClick={() => requestRoleChange(user, nextRole)}
                      className="rounded-md border border-slate-200 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50"
                    >
                      {nextRole === "admin" ? "Promote to admin" : "Demote to user"}
                      {isSelf && " (you)"}
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="mt-4 flex items-center justify-between text-sm text-slate-500">
        <span>
          {total === 0 ? "No results" : `Showing ${rangeStart}-${rangeEnd} of ${total}`}
        </span>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => setOffset((current) => Math.max(0, current - PAGE_SIZE))}
            disabled={offset === 0}
            className="rounded-md border border-slate-200 px-3 py-1.5 font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-40"
          >
            Previous
          </button>
          <button
            type="button"
            onClick={() => setOffset((current) => current + PAGE_SIZE)}
            disabled={rangeEnd >= total}
            className="rounded-md border border-slate-200 px-3 py-1.5 font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-40"
          >
            Next
          </button>
        </div>
      </div>

      <ConfirmDialog
        open={pending !== null}
        title={pending?.nextRole === "admin" ? "Promote to admin?" : "Demote to regular user?"}
        description={
          pending && (
            <>
              {pending.nextRole === "admin" ? (
                <>
                  <strong>{pending.user.displayName}</strong> will gain full admin access,
                  including the ability to moderate content and manage other users' roles.
                </>
              ) : (
                <>
                  <strong>{pending.user.displayName}</strong> will lose admin access.
                  {pending.user.id === currentUser?.id &&
                    " This is your own account - if you're the last remaining admin, the API will reject this."}
                </>
              )}
            </>
          )
        }
        confirmLabel={pending?.nextRole === "admin" ? "Promote" : "Demote"}
        danger={pending?.nextRole === "user"}
        pending={mutation.isPending}
        onConfirm={() => pending && mutation.mutate(pending)}
        onCancel={() => setPending(null)}
      />
    </div>
  );
}
