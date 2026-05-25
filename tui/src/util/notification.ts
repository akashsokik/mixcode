export type NotificationKind = "info" | "success" | "error";

export type Notification = {
  id: string;
  message: string;
  kind: NotificationKind;
  expiresAt: number;
};

let counter = 0;

export function makeNotification(
  message: string,
  kind: NotificationKind = "info",
  durationMs = 2500,
): Notification {
  counter += 1;
  return {
    id: `nx-${Date.now()}-${counter}`,
    message,
    kind,
    expiresAt: Date.now() + durationMs,
  };
}
