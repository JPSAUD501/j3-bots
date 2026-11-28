// SPDX-License-Identifier: AGPL-3.0-or-later
// @effect-diagnostics nodeBuiltinImport:off -- the history is written as the app quits, after which no fiber runs.
import * as NodeFS from "node:fs";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import { app } from "electron";
import { History, type Visit, withVisit } from "./history.ts";

// Where the shared tabs went, kept between launches in one file.

const decodeHistory = Schema.decodeUnknownOption(Schema.fromJsonString(History));
const encodeHistory = Schema.encodeSync(Schema.fromJsonString(History));

/** How long visits gather before the history is written. */
const HISTORY_WRITE_DELAY = Duration.seconds(2);

export interface HistoryStore {
  /** The visits, the latest first. */
  readonly visits: () => ReadonlyArray<Visit>;
  /** Keeps `visit`, written to the file a moment later. */
  readonly visited: (visit: Visit) => void;
}

/** The history kept in `file`, for as long as the scope lives, written once more as it ends. */
export const makeHistoryStore = (
  file: string,
): Effect.Effect<HistoryStore, never, Scope.Scope | FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const runFork = Effect.runForkWith(yield* Effect.context<never>());
    let visits: ReadonlyArray<Visit> = yield* fs.readFileString(file).pipe(
      Effect.map((text) =>
        Option.match(decodeHistory(text), { onNone: () => [], onSome: (kept) => kept.visits }),
      ),
      Effect.orElseSucceed((): ReadonlyArray<Visit> => []),
    );
    let writing = false;
    const save = Effect.gen(function* () {
      writing = false;
      const next = `${file}.next`;
      yield* fs.writeFileString(next, encodeHistory({ visits }));
      yield* fs.rename(next, file);
    }).pipe(
      Effect.catch((error) => Effect.logWarning("Keeping the browser's history failed", error)),
    );
    const write = Effect.andThen(Effect.sleep(HISTORY_WRITE_DELAY), save);
    // A visit still waiting to be written as the app quits is written then, before the
    // process ends: Electron ends it on quit without closing this scope, so not in a fiber.
    const saveNow = () => {
      if (!writing) return;
      writing = false;
      try {
        NodeFS.writeFileSync(`${file}.next`, encodeHistory({ visits }));
        NodeFS.renameSync(`${file}.next`, file);
      } catch {
        // The visits since the last write are lost; the file before them stays whole.
      }
    };
    yield* Effect.acquireRelease(
      Effect.sync(() => app.on("will-quit", saveNow)),
      () =>
        Effect.sync(() => {
          app.off("will-quit", saveNow);
          saveNow();
        }),
    );
    return {
      visits: () => visits,
      visited: (visit) => {
        visits = withVisit(visits, visit);
        if (writing) return;
        writing = true;
        runFork(write);
      },
    };
  });
