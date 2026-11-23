// SPDX-License-Identifier: AGPL-3.0-or-later
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import type { PrivateFiles } from "./PrivateFiles.ts";

/**
 * The folder of a harness home where the harness lists the skills it offers
 * the model, one folder per skill with a `SKILL.md`, links followed: Claude
 * Code's `$CLAUDE_CONFIG_DIR/skills` and Codex's `$CODEX_HOME/skills`.
 * **Verified** with Claude Code 2.1.328 (the `skills` of its `init` message,
 * and the skill list in the request it sends) and Codex 0.170.0 (its app
 * server's `skills/list`), each with a fresh home holding a linked skill
 * folder: both listed it, and both left out a link to a folder that was gone.
 */
const HARNESS_SKILLS = "skills";

/** The file a harness reads in each skill's folder. */
const SKILL_FILE = "SKILL.md";

/** The links J3 Bots made in a home's skill folder: each name, and what its link holds. */
const LinkRecord = Schema.fromJsonString(Schema.Record(Schema.String, Schema.String));
const noLinks = (): Record<string, string> => ({});
const decodeRecord = Schema.decodeUnknownOption(LinkRecord);
const encodeRecord = Schema.encodeEffect(LinkRecord);

/** A name that is one entry of a folder, and not a dot entry such as Codex's `.system`. */
const isSkillName = (path: Path.Path, name: string) =>
  name !== "" && !name.startsWith(".") && path.basename(name) === name;

/**
 * The shared skills' names: the folders in `shared`, links resolved, whose
 * names do not start with a dot and whose `SKILL.md` is a regular file. An
 * entry that cannot be read is skipped, and a `shared` that cannot be read as
 * a folder holds none, each with a warning; a missing `shared` holds none.
 */
const sharedSkillNames = Effect.fnUntraced(function* (shared: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const entries = yield* fs.readDirectory(shared).pipe(
    Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed([])),
    Effect.catchTag("PlatformError", (error) =>
      Effect.as(
        Effect.logWarning(
          `${shared} cannot be read as a folder (${error.message}), so no shared skill was linked.`,
        ),
        [],
      ),
    ),
  );
  const names: Array<string> = [];
  for (const name of entries.toSorted()) {
    if (!isSkillName(path, name)) continue;
    const folder = path.join(shared, name);
    const isSkill = yield* fs.stat(folder).pipe(
      Effect.flatMap((info) =>
        info.type === "Directory"
          ? Effect.map(fs.lstat(path.join(folder, SKILL_FILE)), (file) => file.type === "File")
          : Effect.succeed(false),
      ),
      // A link to nothing, a folder without its `SKILL.md`: no skill.
      Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(false)),
      Effect.catchTag("PlatformError", (error) =>
        Effect.as(
          Effect.logWarning(`${folder} cannot be read (${error.message}), so it was not linked.`),
          false,
        ),
      ),
    );
    if (isSkill) names.push(name);
  }
  return names;
});

/**
 * The links J3 Bots made in a home, as `record` holds them; `{}` when there is
 * no record yet, or one that does not decode. `None`, with a warning, when the
 * record is not a regular file (a link is never followed, a FIFO never
 * opened) or its folder has left private state: then nothing J3 Bots made can
 * be told from what the operator put there.
 */
const readRecord = Effect.fnUntraced(function* (files: PrivateFiles, record: string) {
  const fs = yield* FileSystem.FileSystem;
  const unusable = (reason: string) =>
    Effect.as(
      Effect.logWarning(
        `${record} ${reason}, so the links J3 Bots made cannot be told apart and the home's skills were left as they are. Move it aside.`,
      ),
      Option.none<Record<string, string>>(),
    );
  const path = yield* Path.Path;
  if (!(yield* files.contains(path.dirname(record))))
    return yield* unusable("has left private state");
  return yield* fs.lstat(record).pipe(
    Effect.flatMap((info) =>
      info.type === "File"
        ? Effect.map(fs.readFileString(record), (text) =>
            Option.some(Option.getOrElse(decodeRecord(text), noLinks)),
          )
        : unusable("is not a regular file"),
    ),
    Effect.catchReason("PlatformError", "NotFound", () => Effect.succeedSome(noLinks())),
    Effect.catchTag("PlatformError", (error) => unusable(`cannot be read (${error.message})`)),
  );
});

/**
 * Lets a harness home list the shared skills: one link per skill in the
 * home's `skills` folder, `<name>` leading to `<shared>/<name>` by a relative
 * path from the folder's real path, so the links still hold if the data
 * directory is moved whole. Idempotent, and run at every provisioning, so a
 * skill added to the shared folder or removed from it reaches the harness at
 * its next start.
 *
 * - `record` names only the links J3 Bots made: a link is recorded once it
 *   exists, and unrecorded before it is removed. A start cut short can leave
 *   a link unrecorded, which is then the operator's, never a record of a link
 *   J3 Bots did not make.
 * - A recorded link that is still a link holding what was recorded, and still
 *   leads where its skill is now, is kept as it is. One whose skill is no
 *   longer shared, or now lives elsewhere, is removed.
 * - Nothing else in the home's `skills` (a skill of the home's own, Codex's
 *   `.system`, a link made by someone else) is ever removed or replaced, and
 *   no dot entry is touched. Anything already at a shared skill's name wins:
 *   the shared one is not linked under that name.
 * - Only a shared skill whose `SKILL.md` is a regular file, and whose folder,
 *   links resolved, is in private state, is linked: one that leads out of it
 *   is not linked, or loses its link, with a warning.
 * - A home whose `skills` is not a folder of its own (a link, a file), or
 *   whose record cannot be used, is left as it is, with a warning.
 *
 * Shared skills are a convenience, so this never fails: a write or removal
 * that fails stops the linking in that home with a warning, after anything
 * already linked is recorded.
 */
export const linkSharedSkills = (input: {
  readonly files: PrivateFiles;
  /** The harness home. */
  readonly home: string;
  /** The folder of the skills every bot shares. */
  readonly shared: string;
  /** Where the links made in this home are recorded, in the adapter's own folder. */
  readonly record: string;
}) =>
  linkInHome(input).pipe(
    Effect.catchTags({
      StorageExposed: (error) => warnStopped(input.home, error.message),
      PlatformError: (error) => warnStopped(input.home, error.message),
    }),
  );

const warnStopped = (home: string, reason: string) =>
  Effect.logWarning(
    `The shared skills could not be linked in ${home} (${reason}); what was already there was kept.`,
  );

const linkInHome = Effect.fnUntraced(function* (input: {
  readonly files: PrivateFiles;
  readonly home: string;
  readonly shared: string;
  readonly record: string;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const folder = path.join(input.home, HARNESS_SKILLS);

  const existing = yield* fs.lstat(folder).pipe(
    Effect.asSome,
    Effect.catchReason("PlatformError", "NotFound", () => Effect.succeedNone),
  );
  if (Option.isSome(existing) && existing.value.type !== "Directory") {
    return yield* Effect.logWarning(
      `${folder} is not a folder of its own, so the shared skills were not linked there.`,
    );
  }
  yield* input.files.folder(folder);

  const recorded = yield* readRecord(input.files, input.record);
  if (Option.isNone(recorded)) return;

  // Where each shared skill's link leads, from where the home's folder really is.
  const wanted: Record<string, string> = {};
  const names = yield* sharedSkillNames(input.shared);
  // Gone since its names were read: nothing to link.
  const realShared = yield* fs.realPath(input.shared).pipe(Effect.option);
  if (Option.isSome(realShared)) {
    const realFolder = yield* fs.realPath(folder);
    for (const name of names) {
      const skillFolder = path.join(realShared.value, name);
      if (yield* input.files.contains(skillFolder)) {
        wanted[name] = path.relative(realFolder, skillFolder);
      } else {
        yield* Effect.logWarning(
          `${skillFolder} leads out of private state, so the shared skill ${name} was not linked.`,
        );
      }
    }
  }

  // The recorded links still in place, as they were made: kept when still
  // wanted as they are, removed otherwise.
  const kept: Record<string, string> = {};
  const stale: Array<string> = [];
  for (const [name, target] of Object.entries(recorded.value)) {
    if (!isSkillName(path, name)) continue;
    if (!(yield* input.files.holdsLink(path.join(folder, name), target))) continue;
    if (wanted[name] === target) kept[name] = target;
    else stale.push(name);
  }

  // The shared skills to link: those not linked as they are, at a name nothing else holds.
  const missing: Array<readonly [name: string, target: string]> = [];
  for (const [name, target] of Object.entries(wanted)) {
    if (name in kept) continue;
    const entry = path.join(folder, name);
    const free = stale.includes(name)
      ? true
      : yield* fs.lstat(entry).pipe(
          Effect.andThen(
            Effect.logInfo(
              `${entry} already exists and is not a link J3 Bots made, so the shared skill ${name} was not linked there.`,
            ),
          ),
          Effect.as(false),
          Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(true)),
          Effect.catchTag("PlatformError", (error) =>
            Effect.as(
              Effect.logWarning(
                `${entry} cannot be read (${error.message}), so the shared skill ${name} was not linked there.`,
              ),
              false,
            ),
          ),
        );
    if (free) missing.push([name, target]);
  }

  const save = (links: Record<string, string>) =>
    encodeRecord(links).pipe(
      Effect.orDie,
      Effect.flatMap((text) => input.files.write(input.record, text)),
    );

  // Unrecorded before they are removed, so a failed write removes nothing.
  if (Object.keys(kept).length !== Object.keys(recorded.value).length) yield* save(kept);
  for (const name of stale) yield* input.files.unlink(path.join(folder, name));

  // Recorded once they exist: a link refused or failed leaves no entry, and
  // the ones made before a failure are still recorded.
  const made: Record<string, string> = { ...kept };
  const linked = yield* Effect.forEach(
    missing,
    ([name, target]) =>
      input.files.link(path.join(folder, name), target).pipe(
        Effect.tap(() => Effect.sync(() => (made[name] = target))),
        Effect.catchTag("StorageExposed", () => Effect.void),
      ),
    { discard: true },
  ).pipe(Effect.result);
  if (Object.keys(made).length !== Object.keys(kept).length) yield* save(made);
  if (Result.isFailure(linked)) return yield* linked.failure;
});
