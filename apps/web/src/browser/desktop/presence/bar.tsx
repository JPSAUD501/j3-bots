// SPDX-License-Identifier: AGPL-3.0-or-later
import { NO_PAGE_USE, tabFaces, tabLine } from "@j3-bots/client-runtime/presentation";
import type { BrowserTabRef } from "@j3-bots/contracts";
import type { ReactNode } from "react";
import { Faces } from "../../Faces";
import { QuietLine } from "../../QuietLine";
import { useWaitingBots } from "../../waiting";
import { useTabsNow } from "./onTabs";

/** The faces on each tab and the line by its address, for the desktop browser's bar. */
export function useBarPresence(): {
  readonly faces: (tab: BrowserTabRef) => ReactNode;
  readonly line: (tab: BrowserTabRef) => ReactNode;
} {
  const { tabs, now } = useTabsNow();
  const waitsForPerson = useWaitingBots();
  return {
    faces: (ref) => {
      const tab = tabs.get(ref);
      return tab === undefined ? null : <Faces faces={tabFaces(tab, waitsForPerson)} size={16} />;
    },
    line: (ref) => {
      const tab = tabs.get(ref);
      return tab === undefined || tab.onIt.length === 0 ? null : (
        <QuietLine line={tabLine(tab, NO_PAGE_USE, now)} className="min-w-0 shrink" />
      );
    },
  };
}
