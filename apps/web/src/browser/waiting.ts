// SPDX-License-Identifier: AGPL-3.0-or-later
import type { BotId } from "@j3-bots/contracts";
import { useMemo } from "react";
import { useBots } from "../app/context";

/** The bots that wait for the person, whose faces are amber. */
export function useWaitingBots(): ReadonlySet<BotId> {
  const bots = useBots();
  return useMemo(
    () =>
      new Set(
        [...bots.values()].filter((bot) => bot.state._tag === "waiting").map((bot) => bot.id),
      ),
    [bots],
  );
}
