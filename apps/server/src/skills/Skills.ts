// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  type BotId,
  ChangeAuthor,
  type CommandId,
  Conflict,
  type GitRef,
  type GitRepository,
  Invalid,
  NotFound,
  type RepositoryPath,
  Skill,
  SKILL_LIMITS,
  SkillName,
  type SkillScope,
  SkillSource,
  type SkillText,
  skillFrontmatter,
} from "@j3-bots/contracts";
import { Engine } from "@j3-bots/engine-t3";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";
import * as Semaphore from "effect/Semaphore";
import { BotStore } from "../bots/BotStore.ts";
import { CommandReceipts } from "../commands/CommandReceipts.ts";
import { WORKSPACE_ENTRIES } from "../home/entries.ts";
import { Ids } from "../Ids.ts";
import { Layout } from "../Layout.ts";
import { json, Time } from "../persistence/columns.ts";
import {
  NotASkill,
  SKILL_FILE,
  type SkillFetchFailed,
  type SkillFile,
  SkillRepositories,
} from "./SkillRepositories.ts";

/** Names J3 Bots keeps for the skills it ships, which nobody saves, installs or removes. */
const SHIPPED_PREFIX = "j3-";

const isShippedName = (name: string) => name.startsWith(SHIPPED_PREFIX);

/** The record's key of a scope: the bot's id, or `''` for the shared skills. */
const scopeKey = (scope: SkillScope) => (scope._tag === "bot" ? scope.botId : "");

const RecordRow = Schema.Struct({
  scope_key: Schema.String,
  name: Schema.String,
  source_json: json(SkillSource),
  changed_by_json: json(ChangeAuthor),
  changed_at: Time,
});
const encodeSource = Schema.encodeSync(json(SkillSource));
const encodeAuthor = Schema.encodeSync(json(ChangeAuthor));

const decodeName = Schema.decodeUnknownOption(SkillName);

/** A folder's skill files, read whole: paths `/`-separated from the folder. */
type ReadFiles = ReadonlyArray<SkillFile>;

/** What a skill change can fail with, beyond a client command's own errors. */
export type SkillChangeError = Conflict | Invalid | NotFound;

/**
 * Skills (decision 0049, `docs/architecture/server.md`, "Skills"): the shared
 * ones every bot's harness lists, and each bot's own in its workspace's
 * `skills/`, which the engine links into the folders each harness lists in
 * that workspace. The operator changes them from clients, a bot with its
 * tools; both go through here, so the rules and the records are the same.
 */
export class Skills extends Context.Service<
  Skills,
  {
    /** Every skill: the shared ones, then each bot's. */
    readonly list: Effect.Effect<ReadonlyArray<Skill>>;
    readonly subscribe: Stream.Stream<ReadonlyArray<Skill>>;
    readonly read: (
      scope: SkillScope,
      name: SkillName,
    ) => Effect.Effect<SkillText, SkillChangeError>;
    /** Writes `SKILL.md`, creating the skill or keeping the files beside it. */
    readonly save: (input: {
      readonly commandId: CommandId;
      readonly scope: SkillScope;
      readonly name: SkillName;
      readonly text: string;
      readonly by: ChangeAuthor;
    }) => Effect.Effect<Skill, SkillChangeError>;
    /** Replaces the skill with the folder `folder` of a bot's own workspace, links never followed. */
    readonly saveFolder: (input: {
      readonly commandId: CommandId;
      readonly scope: SkillScope;
      readonly name: SkillName;
      readonly owner: BotId;
      readonly folder: string;
      readonly by: ChangeAuthor;
    }) => Effect.Effect<Skill, SkillChangeError | NotASkill>;
    readonly install: (input: {
      readonly commandId: CommandId;
      readonly scope: SkillScope;
      readonly name: SkillName;
      readonly repository: GitRepository;
      readonly path: RepositoryPath;
      readonly ref: GitRef;
      readonly by: ChangeAuthor;
    }) => Effect.Effect<Skill, SkillChangeError | NotASkill | SkillFetchFailed>;
    /** Removes the skill's folder; one already gone is removed. */
    readonly remove: (input: {
      readonly commandId: CommandId;
      readonly scope: SkillScope;
      readonly name: SkillName;
    }) => Effect.Effect<void, SkillChangeError>;
  }
>()("@j3-bots/server/skills/Skills") {}

export const layer = Layer.effect(
  Skills,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const sql = yield* SqlClient.SqlClient;
    const layout = yield* Layout;
    const store = yield* BotStore;
    const engine = yield* Engine;
    const receipts = yield* CommandReceipts;
    const repositories = yield* SkillRepositories;
    const ids = yield* Ids;
    const changes = yield* PubSub.unbounded<void>();
    const changing = yield* Semaphore.make(1);

    const records = SqlSchema.findAll({
      Request: Schema.Void,
      Result: RecordRow,
      execute: () =>
        sql`SELECT scope_key, name, source_json, changed_by_json, changed_at FROM skill_records`,
    });

    const privateLocation = () => new Conflict({ reason: "private-location" });

    /**
     * The folder of a scope's skills, which must be a real folder of private
     * state: a bot's `skills/` in its workspace as first provisioned, never a
     * link the bot put in its place, which could lead to another bot's.
     */
    const scopeFolder = Effect.fn("Skills.scopeFolder")(function* (scope: SkillScope) {
      const folder =
        scope._tag === "all-bots"
          ? layout.sharedSkills
          : yield* Effect.gen(function* () {
              const found = yield* store.find(scope.botId);
              if (Option.isNone(found)) return yield* new NotFound({ resource: "bot" });
              const { workspaceRoot, workspacePath } = found.value;
              return path.join(
                Option.getOrElse(workspaceRoot, () => workspacePath),
                WORKSPACE_ENTRIES.skills,
              );
            });
      yield* layout.writable(folder).pipe(Effect.mapError(privateLocation));
      const kind = yield* fs.lstat(folder).pipe(
        Effect.map((info) => info.type),
        Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed("absent" as const)),
        Effect.orElseSucceed(() => "other" as const),
      );
      if (kind === "absent")
        yield* fs.makeDirectory(folder, { recursive: true }).pipe(Effect.orDie);
      else if (kind !== "Directory") return yield* privateLocation();
      return folder;
    });

    /** A file read only when it is a regular one, links never followed. */
    const readRegular = (file: string) =>
      fs.lstat(file).pipe(
        Effect.flatMap((info) =>
          info.type === "File" ? Effect.asSome(fs.readFile(file)) : Effect.succeedNone,
        ),
        Effect.orElseSucceed(Option.none<Uint8Array>),
      );

    /** The files of a folder beside its `SKILL.md`, counted with no link followed, up to a bound. */
    const countFiles = Effect.fnUntraced(function* (folder: string) {
      let count = 0;
      const walk: (at: string, depth: number) => Effect.Effect<void> = Effect.fnUntraced(function* (
        at: string,
        depth: number,
      ) {
        if (depth > 8 || count > SKILL_LIMITS.files * 4) return;
        const names = yield* fs.readDirectory(at).pipe(Effect.orElseSucceed(() => []));
        for (const name of names) {
          const entry = path.join(at, name);
          const info = yield* fs.lstat(entry).pipe(Effect.option);
          if (Option.isNone(info)) continue;
          if (info.value.type === "Directory") yield* walk(entry, depth + 1);
          else if (info.value.type === "File" && !(depth === 0 && name === SKILL_FILE)) count++;
        }
      });
      yield* walk(folder, 0);
      return count;
    });

    /** The skills of one scope's folder: each real folder with a regular `SKILL.md`. */
    const scopeSkills = Effect.fnUntraced(function* (
      scope: SkillScope,
      folder: string,
      known: ReadonlyMap<string, typeof RecordRow.Type>,
    ) {
      const names = yield* fs.readDirectory(folder).pipe(Effect.orElseSucceed(() => []));
      const skills: Array<Skill> = [];
      for (const raw of [...names].sort()) {
        const name = decodeName(raw);
        if (Option.isNone(name)) continue;
        const skillFolder = path.join(folder, name.value);
        const info = yield* fs.lstat(skillFolder).pipe(Effect.option);
        if (Option.isNone(info) || info.value.type !== "Directory") continue;
        const text = yield* readRegular(path.join(skillFolder, SKILL_FILE));
        if (Option.isNone(text)) continue;
        const front = skillFrontmatter(new TextDecoder().decode(text.value));
        const record = known.get(`${scopeKey(scope)}/${name.value}`);
        skills.push({
          name: name.value,
          scope,
          description: typeof front === "string" ? "" : front.description,
          files: yield* countFiles(skillFolder),
          shipped: scope._tag === "all-bots" && isShippedName(name.value),
          source: record?.source_json ?? null,
          lastChange:
            record === undefined ? null : { by: record.changed_by_json, at: record.changed_at },
        });
      }
      return skills;
    });

    const list = Effect.gen(function* () {
      const rows = yield* records(undefined).pipe(Effect.orDie);
      const known = new Map(rows.map((row) => [`${row.scope_key}/${row.name}`, row]));
      const scopes: Array<SkillScope> = [
        { _tag: "all-bots" },
        ...(yield* store.list).map(({ bot }): SkillScope => ({ _tag: "bot", botId: bot.id })),
      ];
      const all: Array<Skill> = [];
      for (const scope of scopes) {
        const folder = yield* scopeFolder(scope).pipe(Effect.option);
        if (Option.isSome(folder)) all.push(...(yield* scopeSkills(scope, folder.value, known)));
      }
      return all;
    }).pipe(Effect.withSpan("Skills.list"));

    const find = (scope: SkillScope, name: SkillName) =>
      Effect.map(list, (all) =>
        all.find((skill) => skill.name === name && scopeKey(skill.scope) === scopeKey(scope)),
      );

    /**
     * Refuses what no scope may hold: a shipped name, a name the other side
     * holds (a bot's skill and a shared one of one name, which Claude Code
     * would list once), and a new skill past its scope's limit.
     */
    const admit = Effect.fnUntraced(function* (scope: SkillScope, name: SkillName) {
      if (isShippedName(name)) return yield* new Conflict({ reason: "skill-shipped" });
      const all = yield* list;
      const clash = all.some(
        (skill) =>
          skill.name === name &&
          scopeKey(skill.scope) !== scopeKey(scope) &&
          (scope._tag === "all-bots" || skill.scope._tag === "all-bots"),
      );
      if (clash) return yield* new Conflict({ reason: "skill-name-taken" });
      const inScope = all.filter(
        (skill) => scopeKey(skill.scope) === scopeKey(scope) && !skill.shipped,
      );
      if (
        !inScope.some((skill) => skill.name === name) &&
        inScope.length >= SKILL_LIMITS.perScope
      ) {
        return yield* new Conflict({ reason: "skill-limit" });
      }
    });

    /** Checks a `SKILL.md`'s text: in its limit, and with frontmatter naming the skill. */
    const checkText = Effect.fnUntraced(function* (name: SkillName, text: string) {
      const front = skillFrontmatter(text);
      if (
        text.length === 0 ||
        text.length > SKILL_LIMITS.text ||
        typeof front === "string" ||
        front.name !== name
      ) {
        return yield* new Invalid({ reason: "skill-text" });
      }
    });

    /** The skill's own folder in its scope: absent, or a real folder, never a link. */
    const skillFolder = Effect.fnUntraced(function* (scope: SkillScope, name: SkillName) {
      const folder = path.join(yield* scopeFolder(scope), name);
      const kind = yield* fs.lstat(folder).pipe(
        Effect.map((info) => info.type),
        Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed("absent" as const)),
        Effect.orElseSucceed(() => "other" as const),
      );
      if (kind !== "absent" && kind !== "Directory") return yield* privateLocation();
      return { folder, exists: kind === "Directory" };
    });

    const writeRecord = Effect.fnUntraced(function* (
      scope: SkillScope,
      name: SkillName,
      source: SkillSource,
      by: ChangeAuthor,
    ) {
      const at = yield* DateTime.now;
      yield* sql`
          INSERT INTO skill_records (scope_key, bot_id, name, source_json, changed_by_json, changed_at)
          VALUES (${scopeKey(scope)}, ${scope._tag === "bot" ? scope.botId : null}, ${name},
                  ${encodeSource(source)}, ${encodeAuthor(by)}, ${DateTime.formatIso(at)})
          ON CONFLICT (scope_key, name) DO UPDATE SET
            source_json = excluded.source_json,
            changed_by_json = excluded.changed_by_json,
            changed_at = excluded.changed_at
        `.pipe(Effect.orDie);
    });

    /** Lets the harnesses list the scope's skills as they now are, and every client see them. */
    const changed = Effect.fnUntraced(function* (scope: SkillScope) {
      if (scope._tag === "all-bots") yield* engine.linkSharedSkills;
      else {
        const found = yield* store.find(scope.botId);
        if (Option.isSome(found)) yield* engine.linkBotSkills(found.value.workspacePath);
      }
      yield* PubSub.publish(changes, undefined);
    });

    /** The skill as just written; one gone already was removed by hand meanwhile. */
    const written = Effect.fnUntraced(function* (scope: SkillScope, name: SkillName) {
      const skill = yield* find(scope, name);
      if (skill === undefined) return yield* new NotFound({ resource: "skill" });
      return skill;
    });

    const writeFile = (file: string, data: string | Uint8Array) =>
      layout.writeFile(file, data).pipe(
        Effect.catchTags({
          PrivateLocationExposed: () => Effect.fail(privateLocation()),
          PlatformError: Effect.die,
        }),
      );

    const save = Effect.fn("Skills.save")(function* (input: {
      readonly commandId: CommandId;
      readonly scope: SkillScope;
      readonly name: SkillName;
      readonly text: string;
      readonly by: ChangeAuthor;
    }) {
      yield* checkText(input.name, input.text);
      return yield* changing.withPermits(1)(
        Effect.gen(function* () {
          yield* admit(input.scope, input.name);
          const { folder } = yield* skillFolder(input.scope, input.name);
          yield* receipts.once({
            commandId: input.commandId,
            method: "skill.save",
            payload: { scope: input.scope, name: input.name, text: input.text },
            result: Schema.Void,
            apply: Effect.gen(function* () {
              yield* writeFile(path.join(folder, SKILL_FILE), input.text);
              yield* writeRecord(input.scope, input.name, { _tag: "written" }, input.by);
            }),
          });
          yield* changed(input.scope);
          return yield* written(input.scope, input.name);
        }),
      );
    });

    /**
     * Replaces a skill's folder whole with `files`: written into a dot folder
     * beside it, which no harness lists, then moved into its place.
     */
    const replaceWhole = Effect.fnUntraced(function* (
      scope: SkillScope,
      name: SkillName,
      files: ReadFiles,
      source: SkillSource,
      by: ChangeAuthor,
      command: {
        readonly commandId: CommandId;
        readonly method: string;
        readonly payload: unknown;
      },
    ) {
      const skillText = files.find((file) => file.path === SKILL_FILE);
      if (skillText === undefined)
        return yield* new NotASkill({ reason: `it holds no ${SKILL_FILE}` });
      const text = new TextDecoder().decode(skillText.data);
      yield* checkText(name, text).pipe(
        Effect.mapError(() => {
          const front = skillFrontmatter(text);
          return new NotASkill({
            reason:
              text.length > SKILL_LIMITS.text
                ? `its ${SKILL_FILE} is longer than ${SKILL_LIMITS.text} characters`
                : typeof front === "string"
                  ? front
                  : `its ${SKILL_FILE} names the skill ${front.name}, not ${name}`,
          });
        }),
      );
      return yield* changing.withPermits(1)(
        Effect.gen(function* () {
          yield* admit(scope, name);
          const { folder, exists } = yield* skillFolder(scope, name);
          const parent = path.dirname(folder);
          const tag = yield* ids.make("skill");
          const staging = path.join(parent, `.j3-new-${name}-${tag}`);
          const old = path.join(parent, `.j3-old-${name}-${tag}`);
          yield* receipts.once({
            ...command,
            result: Schema.Void,
            apply: Effect.gen(function* () {
              for (const file of files)
                yield* writeFile(path.join(staging, ...file.path.split("/")), file.data);
              if (exists) yield* Effect.orDie(fs.rename(folder, old));
              // Until the new folder and its record are both in place, the old one can go back.
              yield* Effect.gen(function* () {
                yield* Effect.orDie(fs.rename(staging, folder));
                yield* writeRecord(scope, name, source, by);
              }).pipe(
                Effect.onError(() =>
                  exists
                    ? Effect.gen(function* () {
                        yield* fs.remove(folder, { recursive: true }).pipe(Effect.ignore);
                        yield* fs.rename(old, folder);
                      }).pipe(Effect.ignore)
                    : Effect.void,
                ),
              );
            }).pipe(
              Effect.ensuring(
                Effect.all(
                  [fs.remove(staging, { recursive: true }), fs.remove(old, { recursive: true })],
                  {
                    discard: true,
                  },
                ).pipe(Effect.ignore),
              ),
            ),
          });
          yield* changed(scope);
          return yield* written(scope, name);
        }),
      );
    });

    /** A folder of a bot's workspace, read whole: real folders and regular files only, in the limits. */
    const readFolder = Effect.fnUntraced(function* (owner: BotId, relative: string) {
      const found = yield* store.find(owner);
      if (Option.isNone(found)) return yield* new NotFound({ resource: "bot" });
      const root = Option.getOrElse(found.value.workspaceRoot, () => found.value.workspacePath);
      const realRoot = yield* fs.realPath(root).pipe(Effect.mapError(privateLocation));
      const start = path.resolve(realRoot, relative);
      if (start !== realRoot && !start.startsWith(`${realRoot}${path.sep}`)) {
        return yield* new NotASkill({ reason: "the folder is not in your workspace" });
      }
      const files: Array<SkillFile> = [];
      let bytes = 0;
      const walk: (at: string, prefix: string) => Effect.Effect<void, NotASkill> =
        Effect.fnUntraced(function* (at: string, prefix: string) {
          const info = yield* fs
            .lstat(at)
            .pipe(
              Effect.mapError(
                () => new NotASkill({ reason: `${prefix || relative} cannot be read` }),
              ),
            );
          if (info.type === "SymbolicLink")
            return yield* new NotASkill({ reason: `${prefix || relative} is a link` });
          if (info.type === "Directory") {
            const names = yield* fs.readDirectory(at).pipe(Effect.orElseSucceed(() => []));
            for (const name of [...names].sort()) {
              yield* walk(path.join(at, name), prefix === "" ? name : `${prefix}/${name}`);
            }
            return;
          }
          if (info.type !== "File")
            return yield* new NotASkill({ reason: `${prefix} is not a regular file` });
          if (prefix.length > SKILL_LIMITS.pathLength)
            return yield* new NotASkill({ reason: `${prefix} is too long a path` });
          if (files.length > SKILL_LIMITS.files) {
            return yield* new NotASkill({
              reason: `it holds more than ${SKILL_LIMITS.files} files beside ${SKILL_FILE}`,
            });
          }
          bytes += Number(info.size);
          if (bytes > SKILL_LIMITS.bytes) {
            return yield* new NotASkill({
              reason: `it is larger than ${SKILL_LIMITS.bytes / 1024 / 1024} MiB`,
            });
          }
          const data = yield* fs
            .readFile(at)
            .pipe(Effect.mapError(() => new NotASkill({ reason: `${prefix} cannot be read` })));
          files.push({ path: prefix, data });
        });
      const top = yield* fs.lstat(start).pipe(Effect.option);
      if (Option.isNone(top) || top.value.type !== "Directory") {
        return yield* new NotASkill({ reason: `${relative} is not a folder of your workspace` });
      }
      // A link anywhere on the way, not only the folder itself, would lead the walk out of the
      // workspace: the folder's real path must be the path as written.
      const realStart = yield* fs.realPath(start).pipe(Effect.option);
      if (Option.isNone(realStart) || realStart.value !== start) {
        return yield* new NotASkill({ reason: `${relative} goes through a link` });
      }
      yield* walk(start, "");
      return files;
    });

    const remove = Effect.fn("Skills.remove")(function* (input: {
      readonly commandId: CommandId;
      readonly scope: SkillScope;
      readonly name: SkillName;
    }) {
      if (isShippedName(input.name)) return yield* new Conflict({ reason: "skill-shipped" });
      yield* changing.withPermits(1)(
        Effect.gen(function* () {
          const { folder, exists } = yield* skillFolder(input.scope, input.name);
          yield* receipts.once({
            commandId: input.commandId,
            method: "skill.remove",
            payload: input,
            result: Schema.Void,
            apply: Effect.gen(function* () {
              if (exists) yield* fs.remove(folder, { recursive: true });
              yield* sql`
                DELETE FROM skill_records WHERE scope_key = ${scopeKey(input.scope)} AND name = ${input.name}
              `;
            }).pipe(Effect.orDie),
          });
          yield* changed(input.scope);
        }),
      );
    });

    const read = Effect.fn("Skills.read")(function* (scope: SkillScope, name: SkillName) {
      const { folder, exists } = yield* skillFolder(scope, name);
      if (!exists) return yield* new NotFound({ resource: "skill" });
      const data = yield* readRegular(path.join(folder, SKILL_FILE));
      if (Option.isNone(data)) return yield* new NotFound({ resource: "skill" });
      const text = new TextDecoder().decode(data.value);
      if (text.length === 0 || text.length > SKILL_LIMITS.text)
        return yield* new Invalid({ reason: "skill-text" });
      return text;
    });

    const saveFolder = Effect.fn("Skills.saveFolder")(function* (input: {
      readonly commandId: CommandId;
      readonly scope: SkillScope;
      readonly name: SkillName;
      readonly owner: BotId;
      readonly folder: string;
      readonly by: ChangeAuthor;
    }) {
      const files = yield* readFolder(input.owner, input.folder);
      return yield* replaceWhole(input.scope, input.name, files, { _tag: "written" }, input.by, {
        commandId: input.commandId,
        method: "skill.saveFolder",
        payload: { scope: input.scope, name: input.name, owner: input.owner, folder: input.folder },
      });
    });

    const install = Effect.fn("Skills.install")(function* (input: {
      readonly commandId: CommandId;
      readonly scope: SkillScope;
      readonly name: SkillName;
      readonly repository: GitRepository;
      readonly path: RepositoryPath;
      readonly ref: GitRef;
      readonly by: ChangeAuthor;
    }) {
      const { by, commandId, ...payload } = input;
      const fetched = yield* repositories.fetch(input);
      const source: SkillSource = {
        _tag: "git",
        repository: input.repository,
        path: input.path,
        commit: fetched.commit,
      };
      return yield* replaceWhole(input.scope, input.name, fetched.files, source, by, {
        commandId,
        method: "skill.install",
        payload,
      });
    });

    return Skills.of({
      list,
      subscribe: Stream.unwrap(
        Effect.gen(function* () {
          // Joined before the first list is read, so no change falls between.
          const subscription = yield* PubSub.subscribe(changes);
          return Stream.concat(
            Stream.fromEffect(list),
            Stream.fromSubscription(subscription).pipe(Stream.mapEffect(() => list)),
          );
        }),
      ),
      read,
      save,
      saveFolder,
      install,
      remove,
    });
  }),
);
