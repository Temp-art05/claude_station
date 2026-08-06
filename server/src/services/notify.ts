import { execFile } from "node:child_process";
import { setting } from "../lib/config";

/**
 * Long turns finish while the tab is in the background. The browser shows a Web
 * Notification when it's listening; this is the fallback for when nothing is.
 */
export function notify(title: string, body: string): void {
  if (!setting("notifications.enabled")) return;
  if (process.platform !== "darwin") return;
  const escape = (s: string) => s.replace(/["\\]/g, "\\$&").slice(0, 200);
  execFile(
    "osascript",
    ["-e", `display notification "${escape(body)}" with title "${escape(title)}"`],
    () => {
      /* notifications are best-effort */
    },
  );
}
