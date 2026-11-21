// SPDX-License-Identifier: AGPL-3.0-or-later
import { sharedSkills } from "@j3-bots/prompts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { Layout } from "../Layout.ts";

/** The file a harness reads in each skill's folder. */
const SKILL_FILE = "SKILL.md";

/**
 * Writes the skills J3 Bots ships into the home's shared skills, as
 * `<name>/SKILL.md` (`docs/prompts/architecture.md#skills`). Each one is
 * rewritten whole, so a release's text replaces the last one's; the
 * operator's own skills, under other names, are left alone. A skill whose
 * folder has left private state is skipped with a warning, as every private
 * write is.
 */
export const install = Effect.fn("SharedSkills.install")(function* () {
  const layout = yield* Layout;
  const path = yield* Path.Path;
  for (const skill of sharedSkills) {
    yield* layout
      .writeFile(path.join(layout.sharedSkills, skill.name, SKILL_FILE), skill.text)
      .pipe(
        Effect.catchTags({
          PrivateLocationExposed: (error) => Effect.logWarning(`${error.message} It was skipped.`),
          PlatformError: Effect.die,
        }),
      );
  }
});

/** Installs the shipped skills once, when the server starts. */
export const layer = Layer.effectDiscard(install());
