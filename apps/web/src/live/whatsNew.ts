// SPDX-License-Identifier: AGPL-3.0-or-later
import { type J3Client, makeWhatsNew, type WhatsNew, whatsNewStore } from "@j3-bots/client-runtime";
import { useJ3Client, useReadable } from "@j3-bots/client-runtime/react";
import { WHATS_NEW } from "@j3-bots/i18n/whats-new";
import type { WhatsNewIntents } from "../components/WhatsNew";

// "What's new" on the web and in the desktop app: one per client, kept in
// this browser's storage, as the update prompt's "Later" is.

const SEEN_KEY = "j3:whatsNewSeen";

const made = new WeakMap<J3Client, WhatsNew>();

const whatsNewOf = (j3: J3Client): WhatsNew => {
  const found = made.get(j3);
  if (found !== undefined) return found;
  const whatsNew = makeWhatsNew({
    server: j3.serverUpdate.view,
    catalog: WHATS_NEW,
    store: whatsNewStore({
      get: () => window.localStorage.getItem(SEEN_KEY),
      set: (value) => window.localStorage.setItem(SEEN_KEY, value),
    }),
  });
  made.set(j3, whatsNew);
  return whatsNew;
};

export function useWhatsNew(): WhatsNewIntents {
  const whatsNew = whatsNewOf(useJ3Client());
  return { view: useReadable(whatsNew.view), open: whatsNew.open };
}
