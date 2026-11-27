// SPDX-License-Identifier: AGPL-3.0-or-later
import type { BotId } from "@j3-bots/contracts";
import { Storage } from "expo-sqlite/kv-store";

const LAST_SHARED = "share.lastBot";

/** The bot the operator last shared to, as this phone remembers it. */
export const lastSharedTo = (): string | null => {
  try {
    return Storage.getItemSync(LAST_SHARED);
  } catch {
    return null;
  }
};

/** Remembers that the operator shared to `botId`; a phone that cannot keep it forgets it. */
export const rememberSharedTo = (botId: BotId): void => {
  try {
    Storage.setItemSync(LAST_SHARED, botId);
  } catch {
    // Only the order of the next share sheet is lost.
  }
};
