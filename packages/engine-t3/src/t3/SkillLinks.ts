// SPDX-License-Identifier: AGPL-3.0-or-later
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
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

/** The links one provisioning made in a home's skill folder: each name, and what its link holds. */
const LinkRecord = Schema.fromJsonString(Schema.Record(Schema.String, Schema.String));
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
 * Lets a harness home list the shared skills: one link per skill in the
 * home's `skills` folder, `<name>` leading to `<shared>/<name>` by a relative
 * path from the folder's real path, so the links still hold if the data
 * directory is moved whole. Idempotent, and run at every provisioning, so a
 * skill added to the shared folder or removed from it reaches the harness at
 * its next start.
 *
 * - The links made last time, as `record` names them, are removed first, each
 *   only while it is still a link holding what was recorded, and made again,
 *   so a skill no longer shared loses its link.
 * - Nothing else in the home's `skills` (a skill of the home's own, Codex's
 *   `.system`, a link made by someone else) is ever removed or replaced, and
 *   no dot entry is touched. Anything already at a shared skill's name wins:
 *   the shared one is not linked under that name.
 * - Only a shared skill whose `SKILL.md` is a regular file is linked, and each
 *   link is made through `PrivateFiles.link`, so a shared skill whose folder
 *   leads out of private state is not linked; its refusal is logged.
 * - A home whose `skills` is not a folder of its own (a link, a file) is left
 *   as it is, with a warning, and no link is made or removed there.
 */
export const linkSharedSkills = Effect.fnUntraced(function* (input: {
  readonly files: PrivateFiles;
  /** The harness home. */
  readonly home: string;
  /** The folder of the skills every bot shares. */
  readonly shared: string;
  /** Where the links made in this home are recorded, in the adapter's own folder. */
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

  const recorded = yield* fs.readFileString(input.record).pipe(
    Effect.map((text) => Option.getOrElse(decodeRecord(text), () => ({}))),
    Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed({})),
    Effect.catchTag("PlatformError", (error) =>
      Effect.as(
        Effect.logWarning(
          `${input.record} cannot be read (${error.message}), so no link made before was removed.`,
        ),
        {},
      ),
    ),
  );
  for (const [name, target] of Object.entries(recorded)) {
    if (!isSkillName(path, name)) continue;
    const entry = path.join(folder, name);
    const isOurs = yield* fs.readLink(entry).pipe(
      Effect.map((held) => held === target),
      Effect.orElseSucceed(() => false),
    );
    if (isOurs) yield* input.files.unlink(entry);
  }

  const names = yield* sharedSkillNames(input.shared);
  // Gone since its names were read: nothing to link.
  const realShared = yield* fs.realPath(input.shared).pipe(Effect.option);
  const realFolder = yield* fs.realPath(folder);
  const planned: Record<string, string> = {};
  for (const name of names) {
    if (Option.isNone(realShared)) break;
    const entry = path.join(folder, name);
    const taken = yield* fs.lstat(entry).pipe(
      Effect.as(true),
      Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(false)),
      // Whatever it is, it is not a link this made.
      Effect.catchTag("PlatformError", () => Effect.succeed(true)),
    );
    if (taken) {
      yield* Effect.logInfo(
        `${entry} already exists and is not a link J3 Bots made, so the shared skill ${name} was not linked there.`,
      );
      continue;
    }
    planned[name] = path.relative(realFolder, path.join(realShared.value, name));
  }

  // Recorded before they are made, so a provisioning cut short still knows them.
  yield* input.files.write(input.record, yield* encodeRecord(planned).pipe(Effect.orDie));
  for (const [name, target] of Object.entries(planned)) {
    yield* input.files
      .link(path.join(folder, name), target)
      .pipe(Effect.catchTag("StorageExposed", () => Effect.void));
  }
});
