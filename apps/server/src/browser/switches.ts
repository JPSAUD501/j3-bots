// SPDX-License-Identifier: AGPL-3.0-or-later
import type { BotId } from "@j3-bots/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { BotStore } from "../bots/BotStore.ts";
import { ChangeLog, type ChangeScope } from "../persistence/ChangeLog.ts";

/** A bot's browser switch, as it is after a change. */
export interface BrowserSwitch {
  readonly botId: BotId;
  readonly on: boolean;
}

/**
 * Each change of a bot's browser switch from now on, read from the bots'
 * changes (`ChangeLog`, `bot`): the switch as it stands after each, emitted
 * only when it differs from the one seen before. A bot removed counts as
 * turned off. A bot created from now on is first seen with its switch, which
 * is no change.
 */
export const browserSwitches = Effect.gen(function* () {
  const changeLog = yield* ChangeLog;
  const bots = yield* BotStore;
  // Subscribed before the switches are read, so no change falls between.
  const subscription = yield* changeLog.subscribe;
  const known = new Map((yield* bots.list).map((stored) => [stored.bot.id, stored.bot.browser]));
  return Stream.fromSubscription(subscription).pipe(
    Stream.filter(
      (scope): scope is Extract<ChangeScope, { readonly _tag: "bot" }> => scope._tag === "bot",
    ),
    Stream.mapEffect(({ botId }) =>
      bots.find(botId).pipe(
        Effect.map((found): Option.Option<BrowserSwitch> => {
          const on = Option.exists(found, (stored) => stored.bot.browser);
          const before = known.get(botId);
          if (Option.isNone(found)) known.delete(botId);
          else known.set(botId, on);
          return before === undefined || before === on ? Option.none() : Option.some({ botId, on });
        }),
      ),
    ),
    Stream.filter(Option.isSome),
    Stream.map((change) => change.value),
  );
});
