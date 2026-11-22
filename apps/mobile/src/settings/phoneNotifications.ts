// SPDX-License-Identifier: AGPL-3.0-or-later
import { useJ3Client } from "@j3-bots/client-runtime/react";
import { useEffect, useState } from "react";
import { AppState } from "react-native";
import {
  allowNotifications,
  logUnshown,
  type NotificationAccess,
  readAccess,
} from "../platform/push.ts";
import type { PhoneNotifications } from "./Profile.tsx";

/**
 * What Notifications shows of the phone's permission. Refused once on
 * Android, where the system can still ask again, it offers to allow them as
 * before it asked; refused for good, it says the phone's settings decide.
 */
const shownAccess = {
  undecided: "default",
  denied: "default",
  blocked: "denied",
  granted: "granted",
} as const satisfies Record<Exclude<NotificationAccess, "unavailable">, string>;

/**
 * Whether this phone shows notifications, and what allows them, for
 * Settings' Notifications. `undefined` while the permission is read, and in a
 * build that cannot receive pushes. The permission is read again each time
 * the app comes back to the foreground, so one changed in the phone's
 * settings shows on return.
 */
export function usePhoneNotifications(): PhoneNotifications | undefined {
  const client = useJ3Client();
  const [access, setAccess] = useState<NotificationAccess | null>(null);
  useEffect(() => {
    let mounted = true;
    const read = () => {
      readAccess().then(
        (read) => {
          if (mounted) setAccess(read);
        },
        (error: unknown) =>
          logUnshown("Whether this phone shows notifications could not be read.", error),
      );
    };
    read();
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") read();
    });
    return () => {
      mounted = false;
      subscription.remove();
    };
  }, []);
  if (access === null || access === "unavailable") return undefined;
  return {
    access: shownAccess[access],
    allow: () => {
      allowNotifications(client).then(setAccess, (error: unknown) =>
        logUnshown("Notifications could not be allowed on this phone.", error),
      );
    },
  };
}
