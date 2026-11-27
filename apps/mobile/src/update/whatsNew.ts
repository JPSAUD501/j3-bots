// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  type J3Client,
  makeWhatsNew,
  type WhatsNew,
  type WhatsNewView,
  whatsNewStore,
} from "@j3-bots/client-runtime";
import { useJ3Client, useReadable } from "@j3-bots/client-runtime/react";
import { WHATS_NEW } from "@j3-bots/i18n/whats-new";
import { Storage } from "expo-sqlite/kv-store";

// "What's new" on the phone: one per client, kept in the app's storage, as
// the update prompt's "Later" is.

const SEEN_KEY = "j3:whatsNewSeen";

const made = new WeakMap<J3Client, WhatsNew>();

const whatsNewOf = (client: J3Client): WhatsNew => {
  const found = made.get(client);
  if (found !== undefined) return found;
  const whatsNew = makeWhatsNew({
    server: client.serverUpdate.view,
    catalog: WHATS_NEW,
    store: whatsNewStore({
      get: () => Storage.getItemSync(SEEN_KEY),
      set: (value) => Storage.setItemSync(SEEN_KEY, value),
    }),
  });
  made.set(client, whatsNew);
  return whatsNew;
};

export function useWhatsNew(): { readonly view: WhatsNewView; readonly open: () => void } {
  const whatsNew = whatsNewOf(useJ3Client());
  return { view: useReadable(whatsNew.view), open: whatsNew.open };
}
