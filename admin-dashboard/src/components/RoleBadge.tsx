import type { UserRole } from "../api/types";

export function RoleBadge({ role }: { role: UserRole }) {
  const isAdmin = role === "admin";
  return (
    <span
      className={
        "inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium " +
        (isAdmin ? "bg-brand-100 text-brand-700" : "bg-slate-100 text-slate-600")
      }
    >
      {isAdmin ? "Admin" : "User"}
    </span>
  );
}
