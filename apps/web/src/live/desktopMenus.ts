// SPDX-License-Identifier: AGPL-3.0-or-later
import type { DeviceId, RosterItem } from "@j3-bots/contracts";
import type { ShortcutStatus } from "@j3-bots/desktop-bridge";
import { useEffect, useMemo, useState } from "react";
import { useI18n } from "../app/context";
import type { DesktopShortcut } from "../shell/data";
import { desktop } from "./desktop";
import { trayReport } from "./tray";

// What the desktop app's menus, tray and global shortcut need from the page.

/** Tells the desktop app the language the page shows, which its menus follow. */
export function useReportLanguage(): void {
  const { locale } = useI18n();
  useEffect(() => {
    desktop?.reportLanguage(locale);
  }, [locale]);
}

/**
 * Tells the desktop app's tray what needs the operator in `roster`, under
 * `pairing`, as it changes, and that nothing does once this page stops
 * following that pairing.
 */
export function useReportTray(
  roster: ReadonlyArray<RosterItem> | null,
  pairing: DeviceId | null,
): void {
  const report = useMemo(() => trayReport(roster, pairing), [roster, pairing]);
  useEffect(() => {
    desktop?.reportTray(report);
  }, [report]);
  useEffect(() => () => desktop?.reportTray(trayReport(null, null)), []);
}

/** The desktop app's global shortcut, read once; absent in a browser, and until the app answers. */
export function useDesktopShortcut(): DesktopShortcut | undefined {
  const [status, setStatus] = useState<ShortcutStatus | null>(null);
  useEffect(() => {
    let current = true;
    void desktop?.shortcutStatus().then((read) => {
      if (current && read !== null) setStatus(read);
    });
    return () => {
      current = false;
    };
  }, []);
  const app = desktop;
  if (app === null || status === null) return undefined;
  return {
    status,
    change: (accelerator) =>
      app.setShortcut(accelerator).then((change) => {
        if (change !== null) setStatus(change.status);
        return change;
      }),
  };
}
