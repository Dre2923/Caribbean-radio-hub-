import { apiFetch } from "./client";
import type { NotificationPreferences } from "./types";

export async function getNotificationPreferences(): Promise<NotificationPreferences> {
  const { preferences } = await apiFetch<{ preferences: NotificationPreferences }>(
    "/v1/me/notification-preferences",
  );
  return preferences;
}

export async function updateNotificationPreferences(
  patch: Partial<NotificationPreferences>,
): Promise<NotificationPreferences> {
  const { preferences } = await apiFetch<{ preferences: NotificationPreferences }>(
    "/v1/me/notification-preferences",
    { method: "PATCH", body: patch },
  );
  return preferences;
}
