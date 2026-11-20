// SPDX-License-Identifier: AGPL-3.0-or-later
import type {
  Bot,
  BotFile,
  BotId,
  MemoryDocument,
  MemoryFile,
  MemoryPath,
  MemoryRevision,
  MemoryScope,
  ModelChoice,
  PermissionMode,
  Profile,
  Routine,
  RoutineId,
} from "@j3-bots/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { Connection } from "../connection/Connection.ts";
import {
  Actions,
  type IntentFailure,
  intentResult,
  type IntentResult,
} from "../intents/Actions.ts";
import { Cell, type Readable, waitFor } from "../Store.ts";
import { type Loaded, makeLive } from "./reads.ts";

/** How many of a bot's newest files its details list. */
const FILES_PAGE = 50;

const memoryKey = (scope: MemoryScope) => (scope._tag === "bot" ? `bot:${scope.botId}` : "shared");

/** What creating a bot takes. Fields left out take the server's defaults. */
export interface BotDraft {
  readonly name: Profile["name"];
  readonly title?: Profile["title"];
  readonly job?: Profile["job"];
  readonly model?: ModelChoice;
  readonly permissionMode?: PermissionMode;
  readonly primary?: boolean;
}

/** What `updateBot` changes. Fields left out keep their value. */
export interface BotChanges {
  readonly profile?: {
    readonly name?: Profile["name"];
    readonly title?: Profile["title"];
    readonly job?: Profile["job"];
  };
  readonly model?: ModelChoice;
  readonly permissionMode?: PermissionMode;
}

/** What `writeMemory` writes: the file's new text, over the revision the operator read. */
export interface MemoryEdit {
  readonly text: string;
  /** Null creates the file. */
  readonly revision: MemoryRevision | null;
}

/**
 * A save under way, with what it sends, or one that failed, with what it sent
 * and why, so a form opened after it can offer the operator's edit again. A
 * save that succeeded leaves nothing: the saved value shows where it lives.
 */
export type Save<C> =
  | { readonly _tag: "saving"; readonly changes: C }
  | { readonly _tag: "failed"; readonly changes: C; readonly failure: IntentFailure };

/** A memory file's key in `memorySaves`. */
export const memorySaveKey = (scope: MemoryScope, path: MemoryPath) =>
  `${memoryKey(scope)}/${path}`;

/** `freshStart`'s key in `Actions`, so the button takes no second press while it runs. */
export const freshStartAction = (botId: BotId) => `fresh-start:${botId}`;

/**
 * A bot as its details show it, and what the operator does to a bot itself:
 * its files, its memory and its routines, live while they are open; creating
 * it, starting it fresh, deleting it.
 */
export class Details extends Context.Service<
  Details,
  {
    /** The bot's newest files, read again whenever a socket opens. */
    readonly files: (
      botId: BotId,
    ) => Effect.Effect<Readable<Loaded<ReadonlyArray<BotFile>>>, never, Scope.Scope>;
    /**
     * The memory files of a bot, or the shared ones, read again whenever a
     * socket opens and after each write from this window.
     */
    readonly memory: (
      scope: MemoryScope,
    ) => Effect.Effect<Readable<Loaded<ReadonlyArray<MemoryFile>>>, never, Scope.Scope>;
    readonly readMemory: (
      scope: MemoryScope,
      path: MemoryPath,
    ) => Effect.Effect<IntentResult<MemoryDocument>>;
    /** The bot's routines, live. */
    readonly routines: (
      botId: BotId,
    ) => Effect.Effect<Readable<Loaded<ReadonlyArray<Routine>>>, never, Scope.Scope>;
    readonly setRoutineEnabled: (
      routineId: RoutineId,
      enabled: boolean,
    ) => Effect.Effect<IntentResult<Routine>>;
    /**
     * Writes a memory file's text, failing with `Conflict("stale-revision")`
     * if it changed since `edit.revision` was read.
     */
    readonly writeMemory: (
      scope: MemoryScope,
      path: MemoryPath,
      edit: MemoryEdit,
    ) => Effect.Effect<IntentResult<MemoryDocument>>;
    /** The latest write of each memory file, by `memorySaveKey`, while under way or once failed. */
    readonly memorySaves: Readable<ReadonlyMap<string, Save<MemoryEdit>>>;
    /** Lets go of a failed write the operator gave up on. One under way stays. */
    readonly dismissMemorySave: (scope: MemoryScope, path: MemoryPath) => void;
    readonly createBot: (draft: BotDraft) => Effect.Effect<IntentResult<Bot>>;
    /** Changes a bot's profile, model or permission mode. The roster shows the result. */
    readonly updateBot: (botId: BotId, changes: BotChanges) => Effect.Effect<IntentResult<Bot>>;
    /**
     * The latest update of each bot, while under way or once failed. It
     * outlives the form that started it, which can close before the answer.
     */
    readonly botSaves: Readable<ReadonlyMap<BotId, Save<BotChanges>>>;
    /** Lets go of a failed update the operator gave up on. One under way stays. */
    readonly dismissBotSave: (botId: BotId) => void;
    readonly freshStart: (botId: BotId) => Effect.Effect<IntentResult>;
    readonly deleteBot: (botId: BotId, deleteFiles: boolean) => Effect.Effect<IntentResult>;
  }
>()("@j3-bots/client-runtime/stores/Details") {}

export const layer = Layer.effect(
  Details,
  Effect.gen(function* () {
    const connection = yield* Connection;
    const actions = yield* Actions;
    const scope = yield* Scope.Scope;

    const files = makeLive<BotId, ReadonlyArray<BotFile>>({
      scope,
      connection,
      keyOf: (botId) => botId,
      follow: (botId, client, set) =>
        client["bot.files"]({ botId, before: null, limit: FILES_PAGE }).pipe(
          Effect.flatMap((page) => set(() => page.files)),
          Effect.andThen(Effect.never),
        ),
    });

    // How many writes this window made to each scope's memory, so its list is read again.
    const written = new Cell<ReadonlyMap<string, number>>(new Map());
    const writesTo = (key: string) => written.get().get(key) ?? 0;

    const memory = makeLive<MemoryScope, ReadonlyArray<MemoryFile>>({
      scope,
      connection,
      keyOf: memoryKey,
      follow: (memoryScope, client, set) => {
        const key = memoryKey(memoryScope);
        // Counted before the read, so a write the read may have missed reads it again.
        return Effect.suspend(() => {
          const seen = writesTo(key);
          return client["memory.list"]({ scope: memoryScope }).pipe(
            Effect.flatMap((list) => set(() => list)),
            Effect.andThen(waitFor(written, () => writesTo(key) !== seen)),
          );
        }).pipe(Effect.forever);
      },
    });

    // Routines are few, so every socket starts again from a snapshot.
    const routines = makeLive<BotId, ReadonlyArray<Routine>>({
      scope,
      connection,
      keyOf: (botId) => botId,
      follow: (botId, client, set) =>
        client["routines.subscribe"]({ botId, after: null }).pipe(
          Stream.runForEach((frame) =>
            set((current) => {
              if (frame._tag === "snapshot") return frame.routines;
              const removed = new Set(frame.remove);
              const byId = new Map(
                (current ?? [])
                  .filter((routine) => !removed.has(routine.id))
                  .map((routine) => [routine.id, routine]),
              );
              for (const routine of frame.upsert) byId.set(routine.id, routine);
              return [...byId.values()];
            }),
          ),
        ),
    });

    const readMemory = (memoryScope: MemoryScope, path: MemoryPath) =>
      connection
        .call((client) => client["memory.read"]({ scope: memoryScope, path }))
        .pipe(Effect.exit, Effect.map(intentResult));

    const memorySaves = new Cell<ReadonlyMap<string, Save<MemoryEdit>>>(new Map());
    const botSaves = new Cell<ReadonlyMap<BotId, Save<BotChanges>>>(new Map());

    const dismissFailed = <K, C>(saves: Cell<ReadonlyMap<K, Save<C>>>, key: K) => {
      if (saves.get().get(key)?._tag !== "failed") return;
      saves.update((current) => {
        const next = new Map(current);
        next.delete(key);
        return next;
      });
    };

    /** Runs `command` as the latest save of `key` in `saves`, and records how it ended. */
    const tracked = Effect.fn("Details.tracked")(function* <K, C, A>(
      saves: Cell<ReadonlyMap<K, Save<C>>>,
      key: K,
      changes: C,
      command: Effect.Effect<IntentResult<A>>,
    ) {
      const saving: Save<C> = { _tag: "saving", changes };
      saves.update((current) => new Map(current).set(key, saving));
      const result = yield* command;
      // A later save of the same thing speaks for itself.
      if (saves.get().get(key) === saving) {
        saves.update((current) => {
          const next = new Map(current);
          if (result._tag === "done") next.delete(key);
          else next.set(key, { _tag: "failed", changes, failure: result.failure });
          return next;
        });
      }
      return result;
    });

    const writeMemory = Effect.fn("Details.writeMemory")(function* (
      memoryScope: MemoryScope,
      path: MemoryPath,
      edit: MemoryEdit,
    ) {
      const commandId = yield* actions.commandId;
      const result = yield* tracked(
        memorySaves,
        memorySaveKey(memoryScope, path),
        edit,
        connection
          .call((client) =>
            client["memory.write"]({
              commandId,
              scope: memoryScope,
              path,
              text: edit.text,
              revision: edit.revision,
            }),
          )
          .pipe(Effect.exit, Effect.map(intentResult)),
      );
      if (result._tag === "done") {
        const key = memoryKey(memoryScope);
        written.update((current) => new Map(current).set(key, writesTo(key) + 1));
      }
      return result;
    });

    const updateBot = Effect.fn("Details.updateBot")(function* (botId: BotId, changes: BotChanges) {
      const commandId = yield* actions.commandId;
      return yield* tracked(
        botSaves,
        botId,
        changes,
        connection
          .call((client) => client["bot.update"]({ commandId, botId, ...changes }))
          .pipe(Effect.exit, Effect.map(intentResult)),
      );
    });

    const setRoutineEnabled = Effect.fn("Details.setRoutineEnabled")(function* (
      routineId: RoutineId,
      enabled: boolean,
    ) {
      const commandId = yield* actions.commandId;
      return yield* connection
        .call((client) => client["routine.update"]({ commandId, routineId, enabled }))
        .pipe(Effect.exit, Effect.map(intentResult));
    });

    const createBot = Effect.fn("Details.createBot")(function* (draft: BotDraft) {
      const commandId = yield* actions.commandId;
      return yield* connection
        .call((client) => client["bot.create"]({ commandId, ...draft }))
        .pipe(Effect.exit, Effect.map(intentResult));
    });

    const freshStart = Effect.fn("Details.freshStart")(function* (botId: BotId) {
      const commandId = yield* actions.commandId;
      return yield* actions.run(
        freshStartAction(botId),
        null,
        connection.call((client) => client["bot.freshStart"]({ commandId, botId })),
      );
    });

    const deleteBot = Effect.fn("Details.deleteBot")(function* (
      botId: BotId,
      deleteFiles: boolean,
    ) {
      const commandId = yield* actions.commandId;
      return yield* connection
        .call((client) => client["bot.delete"]({ commandId, botId, deleteFiles }))
        .pipe(Effect.exit, Effect.map(intentResult));
    });

    return Details.of({
      files: files.acquire,
      memory: memory.acquire,
      readMemory,
      writeMemory,
      memorySaves,
      dismissMemorySave: (memoryScope, path) =>
        dismissFailed(memorySaves, memorySaveKey(memoryScope, path)),
      routines: routines.acquire,
      setRoutineEnabled,
      createBot,
      updateBot,
      botSaves,
      dismissBotSave: (botId) => dismissFailed(botSaves, botId),
      freshStart,
      deleteBot,
    });
  }),
);
