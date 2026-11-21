// SPDX-License-Identifier: AGPL-3.0-or-later
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
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

const lstatIfPresent = (fs: FileSystem.FileSystem, location: string) =>
  fs.lstat(location).pipe(
    Effect.asSome,
    Effect.catchReason("PlatformError", "NotFound", () => Effect.succeedNone),
  );

/**
 * The shared skills' names: the folders in `shared`, links resolved, whose
 * names do not start with a dot. None when the folder does not exist.
 */
const sharedSkillNames = Effect.fnUntraced(function* (shared: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const entries = yield* fs
    .readDirectory(shared)
    .pipe(Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed([])));
  const names: Array<string> = [];
  for (const name of entries.toSorted()) {
    if (name.startsWith(".")) continue;
    const info = yield* fs.stat(path.join(shared, name)).pipe(
      Effect.asSome,
      // A link to nothing is no skill.
      Effect.catchReason("PlatformError", "NotFound", () => Effect.succeedNone),
    );
    if (Option.isSome(info) && info.value.type === "Directory") names.push(name);
  }
  return names;
});

/**
 * Lets a harness home list the shared skills: one link per skill in the
 * home's `skills` folder, `<name>` leading to `<shared>/<name>` by a relative
 * path, so the links still hold if the data directory is moved whole.
 * Idempotent, and run at every provisioning, so a skill added to the shared
 * folder or removed from it reaches the harness at its next start.
 *
 * - The links this made before, recognized by where they lead, are removed
 *   first and made again, so a skill no longer shared loses its link.
 * - Anything else in the home's `skills` (a skill of the home's own, Codex's
 *   `.system`, a link made by someone else) is never removed or replaced. A
 *   skill of the home's own under a shared skill's name wins: the shared one
 *   is not linked under that name.
 * - Each link is made through `PrivateFiles.link`, so a shared skill whose
 *   folder leads out of private state is not linked; its refusal is logged.
 * - A home whose `skills` is not a folder of its own (a link, a file) is left
 *   as it is, with a warning, and no link is made or removed there.
 */
export const linkSharedSkills = Effect.fnUntraced(function* (input: {
  readonly files: PrivateFiles;
  /** The harness home. */
  readonly home: string;
  /** The folder of the skills every bot shares. */
  readonly shared: string;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const folder = path.join(input.home, HARNESS_SKILLS);
  const targetOf = (name: string) => path.relative(folder, path.join(input.shared, name));

  const existing = yield* lstatIfPresent(fs, folder);
  if (Option.isSome(existing) && existing.value.type !== "Directory") {
    return yield* Effect.logWarning(
      `${folder} is not a folder of its own, so the shared skills were not linked there.`,
    );
  }
  yield* input.files.folder(folder);

  for (const name of yield* fs.readDirectory(folder)) {
    const entry = path.join(folder, name);
    const info = yield* fs.lstat(entry);
    if (info.type !== "SymbolicLink") continue;
    if ((yield* fs.readLink(entry)) === targetOf(name)) yield* input.files.remove(entry);
  }

  for (const name of yield* sharedSkillNames(input.shared)) {
    const entry = path.join(folder, name);
    if (Option.isSome(yield* lstatIfPresent(fs, entry))) {
      yield* Effect.logInfo(
        `${entry} is the harness home's own, so it is listed instead of the shared skill ${name}.`,
      );
      continue;
    }
    yield* input.files
      .link(entry, targetOf(name))
      .pipe(Effect.catchTag("StorageExposed", () => Effect.void));
  }
});
