// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Settings as SettingsValue } from "@j3-bots/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Connection } from "../connection/Connection.ts";
import { Actions, intentResult, type IntentResult } from "../intents/Actions.ts";
import { Cell, type Readable } from "../Store.ts";
import { loading, markStale, ready, type Synced } from "./synced.ts";

/** What `settings.update` changes. Fields left out keep their value. */
export type SettingsChanges = Partial<
  Pick<SettingsValue, "operatorName" | "timeZone" | "budgets" | "notifications">
>;

/** A save of the settings: under way, with what it sends, or how the last one ended. */
export type SettingsSave =
  | { readonly _tag: "idle" }
  | { readonly _tag: "saving"; readonly changes: SettingsChanges }
  | { readonly _tag: "saved" }
  | { readonly _tag: "failed" };

/**
 * The operator's preferences. The contract has no subscription for them, so
 * they are read when each socket opens and replaced by what an update returns.
 * A change made on another device shows here after the next reconnect.
 */
export class Settings extends Context.Service<
  Settings,
  {
    readonly state: Readable<Synced<SettingsValue>>;
    /**
     * The latest save, which outlives any screen that shows it: one that waits
     * through a disconnection is still under way when Settings opens again.
     */
    readonly save: Readable<SettingsSave>;
    readonly update: (changes: SettingsChanges) => Effect.Effect<IntentResult<SettingsValue>>;
  }
>()("@j3-bots/client-runtime/stores/Settings") {}

export const layer = Layer.effect(
  Settings,
  Effect.gen(function* () {
    const connection = yield* Connection;
    const actions = yield* Actions;
    const state = new Cell<Synced<SettingsValue>>(loading);
    const save = new Cell<SettingsSave>({ _tag: "idle" });

    yield* connection
      .eachSession((client) =>
        client["settings.get"]().pipe(
          Effect.flatMap((settings) => Effect.sync(() => state.set(ready(settings)))),
          Effect.andThen(Effect.never),
          Effect.ensuring(Effect.sync(() => state.update(markStale))),
        ),
      )
      .pipe(Effect.forkScoped);

    const update = Effect.fn("Settings.update")(function* (changes: SettingsChanges) {
      const commandId = yield* actions.commandId;
      const saving: SettingsSave = { _tag: "saving", changes };
      save.set(saving);
      const exit = yield* connection
        .call((client) => client["settings.update"]({ commandId, ...changes }))
        .pipe(Effect.exit);
      const result = intentResult(exit);
      if (result._tag === "done") state.set(ready(result.value));
      // A later save speaks for itself.
      if (save.get() === saving) save.set({ _tag: result._tag === "done" ? "saved" : "failed" });
      return result;
    });

    return Settings.of({ state, save, update });
  }),
);
