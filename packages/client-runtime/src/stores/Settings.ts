// SPDX-License-Identifier: AGPL-3.0-or-later
import type { NotificationSettingsChange, Settings as SettingsValue } from "@j3-bots/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Connection, type J3RpcClient } from "../connection/Connection.ts";
import { Actions, intentResult, type IntentResult } from "../intents/Actions.ts";
import { Cell, type Readable } from "../Store.ts";
import { loading, markStale, ready, type Synced } from "./synced.ts";

/** What `settings.update` changes. Fields left out keep their value. */
export type SettingsChanges = Partial<
  Pick<SettingsValue, "operatorName" | "timeZone" | "budgets">
> & {
  readonly notifications?: NotificationSettingsChange;
};

/**
 * A save of the settings: under way, or how the last one ended, each with what
 * it sends, so a form can tell its own saves from another's. A failed one
 * keeps what it sent, so a form that did not see it can offer it again.
 */
export type SettingsSave =
  | { readonly _tag: "idle" }
  | {
      readonly _tag: "saving" | "saved" | "failed";
      readonly changes: SettingsChanges;
    };

/**
 * The operator's preferences. The contract has no subscription for them and
 * no revision, so they are read when each socket opens and again after each
 * save the server accepts, and only the read started last is shown. What
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

/**
 * Runs reads of one value and passes on only the answer of the read started
 * last: an older read that answers while a newer one is on its way, or after
 * it, would show what the newer one replaces.
 */
export const latestRead = <A>(show: (value: A) => void) => {
  let started = 0;
  return <E, R>(read: Effect.Effect<A, E, R>): Effect.Effect<void, E, R> =>
    Effect.suspend(() => {
      const ticket = ++started;
      return read.pipe(
        Effect.flatMap((value) =>
          Effect.sync(() => {
            if (ticket === started) show(value);
          }),
        ),
      );
    });
};

export const layer = Layer.effect(
  Settings,
  Effect.gen(function* () {
    const connection = yield* Connection;
    const actions = yield* Actions;
    const state = new Cell<Synced<SettingsValue>>(loading);
    const save = new Cell<SettingsSave>({ _tag: "idle" });

    const latest = latestRead((settings: SettingsValue) => state.set(ready(settings)));
    /** Reads the settings, and shows them unless a read started later is under way or done. */
    const read = (client: J3RpcClient) => latest(client["settings.get"]());

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
        save.set({ _tag: result._tag === "done" ? "saved" : "failed", changes });
      }
      return result;
    });

    return Settings.of({ state, save, update });
  }),
);
