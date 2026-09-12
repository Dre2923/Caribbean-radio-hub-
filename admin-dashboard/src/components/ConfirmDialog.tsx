import type { ReactNode } from "react";

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  description: ReactNode;
  confirmLabel: string;
  danger?: boolean;
  pending?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  // Optional extra form content between the description and the action
  // buttons - e.g. a deactivation-reason textarea. Kept generic here
  // rather than a one-off "reason" prop so this same dialog serves every
  // confirm-with-optional-detail action across the dashboard (station
  // deactivation today, event rejection in Step 33).
  children?: ReactNode;
}

// A real in-app modal rather than the browser's native confirm() - a
// role-change is exactly the kind of consequential admin action a
// professional console confirms with its own styled dialog, not a
// jarring, unstyleable browser-chrome popup.
export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel,
  danger = false,
  pending = false,
  onConfirm,
  onCancel,
  children,
}: ConfirmDialogProps) {
  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="confirm-dialog-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4"
    >
      <div className="w-full max-w-sm rounded-xl bg-white p-6 shadow-xl">
        <h2 id="confirm-dialog-title" className="text-base font-semibold text-slate-900">
          {title}
        </h2>
        <div className="mt-2 text-sm text-slate-600">{description}</div>
        {children && <div className="mt-4">{children}</div>}
        <div className="mt-6 flex justify-end gap-3">
          <button
            type="button"
            onClick={onCancel}
            disabled={pending}
            className="rounded-md px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-100 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={pending}
            className={
              "rounded-md px-3 py-2 text-sm font-medium text-white shadow-sm disabled:opacity-50 " +
              (danger ? "bg-red-600 hover:bg-red-700" : "bg-brand-600 hover:bg-brand-700")
            }
          >
            {pending ? "Working…" : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
