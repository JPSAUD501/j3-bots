// SPDX-License-Identifier: AGPL-3.0-or-later
// @effect-diagnostics nodeBuiltinImport:off -- reads this package's own skills once at load: they are part of the code, not runtime data.
import { readFileSync } from "node:fs";

/**
 * The skills J3 Bots ships: layer 6 of `docs/prompts/architecture.md#layers`.
 * Each is one `SKILL.md`, kept here as `skills/<name>.md`, which the server
 * installs as `<name>/SKILL.md` among the shared skills every bot can read.
 *
 * Names start with `j3-`, so they never take the name of a skill the operator
 * saved. The text is the file as edited, frontmatter included: the harness
 * reads the `name` and `description` there to decide when a skill applies.
 */
export interface SharedSkill {
  /** The skill's folder name, and the `name` in its frontmatter. */
  readonly name: (typeof SKILL_NAMES)[number];
  /** The whole `SKILL.md`. */
  readonly text: string;
}

const SKILL_NAMES = ["j3-mcp-and-skills", "j3-routines", "j3-sending"] as const;

/** The skills J3 Bots ships, as their `SKILL.md` files. */
export const sharedSkills: ReadonlyArray<SharedSkill> = SKILL_NAMES.map((name) => ({
  name,
  text: readFileSync(new URL(`./skills/${name}.md`, import.meta.url), "utf8"),
}));
