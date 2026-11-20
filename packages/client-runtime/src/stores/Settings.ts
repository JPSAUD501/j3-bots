// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Settings as SettingsValue } from "@j3-bots/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Connection, type J3RpcClient } from "../connection/Connection.ts";
import { Actions, intentResult, type IntentResult } from "../intents/Actions.ts";
import { Cell, type Readable } from "../Store.ts";
import { loading, markStale, ready, type Synced } from "./synced.ts";

/** What `settings.update` changes. Fields left out keep their value. */
export type SettingsChanges = Partial<
  Pick<SettingsValue, "operatorName" | "timeZone" | "budgets" | "notifications">
>;

/**
 * A save of the settings: under way, with what it sends, or how the last one
 * ended. A failed one keeps what it sent, so a form that did not see it can
 * offer it again.
 */
export type SettingsSave =
  | { readonly _tag: "idle" }
  | { readonly _tag: "saving"; readonly changes: SettingsChanges }
  | { readonly _tag: "saved" }
  | { readonly _tag: "failed"; readonly changes: SettingsChanges };

/**
 * The operator's preferences. The contract has no subscription for them and
 * no revision, so they are read when each socket opens and again after each
 * save the server accepts, and the read started last is the one shown. What
 * a save returns is not shown: answered again from its receipt after a
 * reconnection, it can be older than what the reconnection read. A change
 * made on another device shows here after the next reconnect or save.
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

    // Reads started, and the latest whose answer is shown.
    let started = 0;
    let shown = 0;
    /** Reads the settings, and shows them unless a read started later already has. */
    const read = (client: J3RpcClient) =>
      Effect.suspend(() => {
        const ticket = ++started;
        return client["settings.get"]().pipe(
          Effect.flatMap((settings) =>
            Effect.sync(() => {
              if (ticket < shown) return;
              shown = ticket;
              state.set(ready(settings));
            }),
          ),
        );
      });

    yield* connection
      .eachSession((client) =>
        read(client).pipe(
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
      if (result._tag === "done") yield* connection.call(read).pipe(Effect.ignore);
      // A later save speaks for itself.
      if (save.get() === saving) {
        save.set(result._tag === "done" ? { _tag: "saved" } : { _tag: "failed", changes });
      }
      return result;
    });

    return Settings.of({ state, save, update });
  }),
);
