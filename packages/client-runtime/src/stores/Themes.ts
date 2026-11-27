// SPDX-License-Identifier: AGPL-3.0-or-later
import type { SavedTheme, ThemeDefinition, ThemeId, ThemeLibrary } from "@j3-bots/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { Connection } from "../connection/Connection.ts";
import { Actions, type IntentResult, intentResult } from "../intents/Actions.ts";
import { Cell, type Readable } from "../Store.ts";
import { Roster } from "./Roster.ts";
import { loading, markStale, ready, type Synced } from "./synced.ts";

/**
 * The themes the server keeps and the theme it starts devices on (decision
 * 0104), kept live on every socket of a server whose roster snapshot says it
 * has them, and the operator's changes to them. Which theme this device
 * shows is the app's own choice, kept on the device.
 */
export class Themes extends Context.Service<
  Themes,
  {
    /** Whether the server keeps themes: only then are saved themes and the form offered. */
    readonly supported: Readable<boolean>;
    readonly state: Readable<Synced<ThemeLibrary>>;
    /** A new theme without `themeId`, or a change to the saved theme `themeId`. */
    readonly save: (
      definition: ThemeDefinition,
      themeId?: ThemeId,
    ) => Effect.Effect<IntentResult<SavedTheme>>;
    readonly remove: (themeId: ThemeId) => Effect.Effect<IntentResult>;
    /** The theme a device shows until its person picks one. */
    readonly setDefault: (themeId: ThemeId) => Effect.Effect<IntentResult>;
  }
>()("@j3-bots/client-runtime/stores/Themes") {}

export const layer = Layer.effect(
  Themes,
  Effect.gen(function* () {
    const connection = yield* Connection;
    const actions = yield* Actions;
    const roster = yield* Roster;
    const state = new Cell<Synced<ThemeLibrary>>(loading);

    yield* connection
      .eachSession((client) =>
        // An older server has no themes: nothing is asked of it.
        roster.themesOn(client).pipe(
          Effect.andThen((has) =>
            has
              ? client["themes.subscribe"]().pipe(
                  Stream.runForEach((library) => Effect.sync(() => state.set(ready(library)))),
                )
              : Effect.void,
          ),
          Effect.ensuring(Effect.sync(() => state.update(markStale))),
        ),
      )
      .pipe(Effect.forkScoped);

    const save = Effect.fn("Themes.save")(function* (
      definition: ThemeDefinition,
      themeId?: ThemeId,
    ) {
      const commandId = yield* actions.commandId;
      return yield* connection
        .call((client) =>
          client["theme.save"]({
            commandId,
            definition,
            ...(themeId === undefined ? {} : { themeId }),
          }),
        )
        .pipe(Effect.exit, Effect.map(intentResult));
    });

    const remove = Effect.fn("Themes.remove")(function* (themeId: ThemeId) {
      const commandId = yield* actions.commandId;
      return yield* connection
        .call((client) => client["theme.delete"]({ commandId, themeId }))
        .pipe(Effect.exit, Effect.map(intentResult));
    });

    const setDefault = Effect.fn("Themes.setDefault")(function* (themeId: ThemeId) {
      const commandId = yield* actions.commandId;
      return yield* connection
        .call((client) => client["theme.setDefault"]({ commandId, themeId }))
        .pipe(Effect.exit, Effect.map(intentResult));
    });

    return Themes.of({ supported: roster.themes, state, save, remove, setDefault });
  }),
);
