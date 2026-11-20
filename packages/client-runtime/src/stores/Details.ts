// SPDX-License-Identifier: AGPL-3.0-or-later
import type {
  Bot,
  BotFile,
  BotId,
  MemoryDocument,
  MemoryFile,
  MemoryPath,
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
import { Actions, intentResult, type IntentResult } from "../intents/Actions.ts";
import type { Readable } from "../Store.ts";
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
    /** The memory files of a bot, or the shared ones, read again whenever a socket opens. */
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
    readonly createBot: (draft: BotDraft) => Effect.Effect<IntentResult<Bot>>;
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

    const memory = makeLive<MemoryScope, ReadonlyArray<MemoryFile>>({
      scope,
      connection,
      keyOf: memoryKey,
      follow: (memoryScope, client, set) =>
        client["memory.list"]({ scope: memoryScope }).pipe(
          Effect.flatMap((list) => set(() => list)),
          Effect.andThen(Effect.never),
        ),
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
      routines: routines.acquire,
      setRoutineEnabled,
      createBot,
      freshStart,
      deleteBot,
    });
  }),
);
