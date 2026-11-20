// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  type BotId,
  type CommandError,
  type CommandId,
  type Conflict,
  type Invalid,
  MemoryDocument,
  type MemoryFile,
  MemoryPath,
  type MemoryRevision,
  type MemoryScope,
  NotFound,
} from "@j3-bots/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { BotStore } from "../bots/BotStore.ts";
import { PINNED_FILE, Workspaces } from "../bots/Workspaces.ts";
import { CommandReceipts } from "../commands/CommandReceipts.ts";
import { SettingsStore } from "../settings/SettingsStore.ts";
import {
  appendLine,
  holdsFact,
  looksLikeCredential,
  oneLine,
  parseFacts,
  type Recalled,
  search,
  withoutFact,
} from "./facts.ts";
import { MemoryFiles } from "./MemoryFiles.ts";

/**
 * Why a memory tool wrote nothing: the file has been linked out of its memory
 * folder (`Invalid("memory-path")`), or the folder out of private state
 * (`Conflict("private-location")`).
 */
export type MemoryRefused = Invalid | Conflict;

/** Where a bot's memory tool acts: its own memory, or the shared one. */
export type FactScope = "bot" | "shared";

export type RememberResult =
  | { readonly recorded: true }
  | { readonly recorded: false; readonly reason: "duplicate" | "looks-like-a-credential" };

/**
 * A bot's memory and the shared memory (`docs/decisions/0006-memory-is-files.md`):
 * the files as the operator reads and edits them, and the facts the bot keeps
 * with its memory tools. A change to a pinned note rewrites the instructions
 * of every bot that reads it.
 */
export class Memory extends Context.Service<
  Memory,
  {
    readonly list: (scope: MemoryScope) => Effect.Effect<ReadonlyArray<MemoryFile>, NotFound>;
    readonly read: (
      scope: MemoryScope,
      path: MemoryPath,
    ) => Effect.Effect<MemoryDocument, NotFound>;
    readonly write: (input: {
      readonly commandId: CommandId;
      readonly scope: MemoryScope;
      readonly path: MemoryPath;
      readonly text: string;
      readonly revision: MemoryRevision | null;
    }) => Effect.Effect<MemoryDocument, CommandError>;
    readonly remember: (input: {
      readonly botId: BotId;
      readonly fact: string;
      readonly tier: "pinned" | "log";
      readonly scope: FactScope;
    }) => Effect.Effect<RememberResult, MemoryRefused>;
    readonly forget: (input: {
      readonly botId: BotId;
      readonly fact: string;
      readonly scope: FactScope;
    }) => Effect.Effect<{ readonly removed: boolean }, MemoryRefused>;
    readonly recall: (input: {
      readonly botId: BotId;
      readonly query: string;
      readonly scope: FactScope | undefined;
      readonly limit: number;
    }) => Effect.Effect<ReadonlyArray<Recalled>>;
  }
>()("@j3-bots/server/memory/Memory") {}

const isLog = (path: MemoryPath) => path.startsWith("log/");

export const layer = Layer.effect(
  Memory,
  Effect.gen(function* () {
    const files = yield* MemoryFiles;
    const bots = yield* BotStore;
    const workspaces = yield* Workspaces;
    const receipts = yield* CommandReceipts;
    const settings = yield* SettingsStore;

    const scopeExists = Effect.fn("Memory.scopeExists")(function* (scope: MemoryScope) {
      if (scope._tag === "shared") return;
      if (Option.isNone(yield* bots.find(scope.botId))) {
        return yield* new NotFound({ resource: "bot" });
      }
    });

    const pinnedOf = (scope: MemoryScope) =>
      scope._tag === "bot" ? PINNED_FILE.bot : PINNED_FILE.shared;

    /** Rewrites the instructions that show `scope`'s pinned note. */
    const pinnedChanged = (scope: MemoryScope) =>
      scope._tag === "bot" ? workspaces.render(scope.botId) : workspaces.renderAll;

    const toScope = (botId: BotId, scope: FactScope): MemoryScope =>
      scope === "bot" ? { _tag: "bot", botId } : { _tag: "shared" };

    /** Today's log file and date, in the operator's time zone. */
    const today = Effect.gen(function* () {
      const { timeZone } = yield* settings.get;
      const zone = DateTime.zoneMakeNamed(timeZone).pipe(
        Option.getOrElse(() => DateTime.zoneMakeNamedUnsafe("UTC")),
      );
      const parts = DateTime.toParts(DateTime.setZone(yield* DateTime.now, zone));
      const month = `${parts.year}-${String(parts.month).padStart(2, "0")}`;
      return {
        date: `${month}-${String(parts.day).padStart(2, "0")}`,
        file: MemoryPath.make(`log/${month}.md`),
      };
    });

    const textsOf = Effect.fn("Memory.textsOf")(function* (
      scope: MemoryScope,
      which: (path: MemoryPath) => boolean,
    ) {
      const listed = yield* files.list(scope);
      const texts: Array<{ readonly path: MemoryPath; readonly text: string }> = [];
      for (const file of listed.filter(({ path }) => which(path))) {
        // Listed paths are already inside the folder.
        const document = yield* files.read(scope, file.path).pipe(Effect.orDie);
        if (Option.isSome(document)) texts.push({ path: file.path, text: document.value.text });
      }
      return texts;
    });

    const remember = Effect.fn("Memory.remember")(function* (input: {
      readonly botId: BotId;
      readonly fact: string;
      readonly tier: "pinned" | "log";
      readonly scope: FactScope;
    }) {
      const fact = oneLine(input.fact);
      if (looksLikeCredential(fact)) {
        return { recorded: false, reason: "looks-like-a-credential" } satisfies RememberResult;
      }
      const scope = toScope(input.botId, input.scope);
      const pinned = pinnedOf(scope);
      const { date, file } = yield* today;
      const target = input.tier === "pinned" ? pinned : file;
      const line = input.tier === "pinned" ? `- ${fact}` : `- ${date}: ${fact}`;
      // A fact already in the tier is not recorded twice. The other log files
      // are read first; the target file is checked again under the write lock.
      const others = yield* textsOf(scope, (path) =>
        input.tier === "pinned" ? false : isLog(path) && path !== target,
      );
      const recorded = yield* files.modify(scope, target, (text) =>
        holdsFact([text, ...others.map(({ text }) => text)], fact)
          ? ([false, Option.none()] as const)
          : ([true, Option.some(appendLine(text, line))] as const),
      );
      if (!recorded) return { recorded: false, reason: "duplicate" } satisfies RememberResult;
      if (input.tier === "pinned") yield* pinnedChanged(scope);
      return { recorded: true } satisfies RememberResult;
    });

    const forget = Effect.fn("Memory.forget")(function* (input: {
      readonly botId: BotId;
      readonly fact: string;
      readonly scope: FactScope;
    }) {
      const scope = toScope(input.botId, input.scope);
      const pinned = pinnedOf(scope);
      const candidates = yield* textsOf(scope, (path) => path === pinned || isLog(path));
      let removed = false;
      for (const { path } of candidates) {
        const changed = yield* files.modify(scope, path, (text) => {
          const next = withoutFact(text, input.fact);
          return [Option.isSome(next), next] as const;
        });
        if (changed && path === pinned) yield* pinnedChanged(scope);
        removed ||= changed;
      }
      return { removed };
    });

    const recall = Effect.fn("Memory.recall")(function* (input: {
      readonly botId: BotId;
      readonly query: string;
      readonly scope: FactScope | undefined;
      readonly limit: number;
    }) {
      const facts: Array<Recalled> = [];
      if (input.scope !== "shared") {
        for (const { text } of yield* textsOf(toScope(input.botId, "bot"), isLog)) {
          for (const fact of parseFacts(text)) facts.push({ ...fact, scope: "bot" });
        }
      }
      if (input.scope !== "bot") {
        const shared = toScope(input.botId, "shared");
        for (const { text } of yield* textsOf(
          shared,
          (path) => isLog(path) || path === PINNED_FILE.shared,
        )) {
          for (const fact of parseFacts(text)) facts.push({ ...fact, scope: "shared" });
        }
      }
      return search(facts, input.query, input.limit);
    });

    const write = Effect.fn("Memory.write")(function* (input: {
      readonly commandId: CommandId;
      readonly scope: MemoryScope;
      readonly path: MemoryPath;
      readonly text: string;
      readonly revision: MemoryRevision | null;
    }) {
      yield* scopeExists(input.scope);
      const document = yield* receipts.once({
        commandId: input.commandId,
        method: "memory.write",
        payload: input,
        result: MemoryDocument,
        apply: files.write(input),
      });
      if (input.path === pinnedOf(input.scope)) yield* pinnedChanged(input.scope);
      return document;
    });

    const list = Effect.fn("Memory.list")(function* (scope: MemoryScope) {
      yield* scopeExists(scope);
      return yield* files.list(scope);
    });

    const read = Effect.fn("Memory.read")(function* (scope: MemoryScope, path: MemoryPath) {
      yield* scopeExists(scope);
      // A path that leaves the folder names no memory file.
      const document = yield* files.read(scope, path).pipe(Effect.orElseSucceed(Option.none));
      if (Option.isNone(document)) return yield* new NotFound({ resource: "memory-file" });
      return document.value;
    });

    return Memory.of({
      list,
      read,
      write,
      remember,
      forget,
      recall,
    });
  }),
);
