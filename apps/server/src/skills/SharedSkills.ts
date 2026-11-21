// SPDX-License-Identifier: AGPL-3.0-or-later
import { sharedSkills } from "@j3-bots/prompts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { Layout } from "../Layout.ts";

/** The file a harness reads in each skill's folder. */
const SKILL_FILE = "SKILL.md";

/**
 * Writes the skills J3 Bots ships into the home's shared skills, as
 * `<name>/SKILL.md` (`docs/prompts/architecture.md#skills`). Each one is
 * rewritten whole, so a release's text replaces the last one's; the
 * operator's own skills, under other names, are left alone.
 *
 * A shipped skill's folder must be a real folder directly in the shared
 * skills, links resolved. One that is a link to another skill's folder, or to
 * anywhere else, or is not a folder at all, is skipped with a warning, so the
 * install never writes over a skill under another name. So is every skill
 * when the shared skills folder itself has left private state.
 */
export const install = Effect.fn("SharedSkills.install")(function* () {
  const layout = yield* Layout;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const realRoot = yield* layout.writable(layout.sharedSkills).pipe(
    Effect.tap((root) => fs.makeDirectory(root, { recursive: true })),
    Effect.flatMap((root) => fs.realPath(root)),
    Effect.catchTags({
      PrivateLocationExposed: (error) =>
        Effect.as(Effect.logWarning(`${error.message} No skill was installed.`), undefined),
      PlatformError: Effect.die,
    }),
  );
  if (realRoot === undefined) return;

  for (const skill of sharedSkills) {
    const folder = path.join(layout.sharedSkills, skill.name);
    const isOwnFolder = yield* fs.makeDirectory(folder, { recursive: true }).pipe(
      Effect.andThen(fs.realPath(folder)),
      Effect.flatMap((real) =>
        real === path.join(realRoot, skill.name)
          ? Effect.map(fs.stat(real), (info) => info.type === "Directory")
          : Effect.succeed(false),
      ),
      // Something that is not a folder, or a link to nowhere, is in the way.
      Effect.catchTag("PlatformError", () => Effect.succeed(false)),
    );
    if (!isOwnFolder) {
      yield* Effect.logWarning(
        `${folder} is not a folder of its own in the shared skills, so the ${skill.name} skill was not installed there.`,
      );
      continue;
    }
    yield* layout.writeFile(path.join(folder, SKILL_FILE), skill.text).pipe(
      Effect.catchTags({
        PrivateLocationExposed: (error) => Effect.logWarning(`${error.message} It was skipped.`),
        PlatformError: Effect.die,
      }),
    );
  }
});

/** Installs the shipped skills once, when the server starts. */
export const layer = Layer.effectDiscard(install());
