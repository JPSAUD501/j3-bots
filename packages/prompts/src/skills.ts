// SPDX-License-Identifier: AGPL-3.0-or-later
// @effect-diagnostics nodeBuiltinImport:off -- reads this package's own skills, and the release its build carries, once at load: they are part of the code, not runtime data.
import { existsSync, readFileSync } from "node:fs";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

/**
 * The skills J3 Bots ships: layer 6 of `docs/prompts/architecture.md#layers`.
 * Each is one `SKILL.md`, kept here as `skills/<name>.md`, which the server
 * installs as `<name>/SKILL.md` among the shared skills every bot can read.
 *
 * Names start with `j3-`, so they never take the name of a skill the operator
 * saved. The text is the file as edited, frontmatter included: the harness
 * reads the `name` and `description` there to decide when a skill applies.
 * `j3-app` is the one exception to "as edited": its last section is the
 * release this build is, filled in below.
 */
export interface SharedSkill {
  /** The skill's folder name, and the `name` in its frontmatter. */
  readonly name: (typeof SKILL_NAMES)[number];
  /** The whole `SKILL.md`. */
  readonly text: string;
}

const SKILL_NAMES = ["j3-app", "j3-mcp-and-skills", "j3-routines", "j3-sending"] as const;

/**
 * The release a build is, as the server's build writes it beside this module
 * (`apps/server/vite.config.ts`): its version, and the "What's new" section
 * of its notes, `docs/releases/v<version>.md`, as written there.
 */
const Release = Schema.Struct({ version: Schema.NonEmptyString, whatsNew: Schema.NonEmptyString });
type Release = typeof Release.Type;

/** Where the server's build writes `Release`: next to this module in the bundle. */
const RELEASE_FILE = new URL("./release.json", import.meta.url);

/**
 * The release this build is. None in a build from source, and in a build of
 * a version without notes, such as a nightly. A file that is there and does
 * not decode is a broken build, and fails at load.
 */
const release: Option.Option<Release> = existsSync(RELEASE_FILE)
  ? Option.some(
      Schema.decodeSync(Schema.fromJsonString(Release))(readFileSync(RELEASE_FILE, "utf8")),
    )
  : Option.none();

/** Where `j3-app` takes the release it describes. */
const RELEASE_NOTES = "{{release.notes}}";

/** `j3-app`'s last section, for `release`. */
const releaseNotes = (release: Option.Option<Release>): string =>
  Option.match(release, {
    onNone: () =>
      "This build of J3 Bots carries no release notes: it was built from source, or it is a nightly. If your user asks what changed, say you do not know, and that About and updates in Settings shows the version they run.",
    onSome: ({ version, whatsNew }) =>
      `These are the release notes of J3 Bots ${version}, the version that installed this skill. You cannot see which version your user's server runs now: a server moved back to an earlier release keeps this skill. So when you tell them what changed, say it is what J3 Bots ${version} brought, and that About and updates in Settings shows the version they run; if it shows another, or they ask about an earlier release, say you do not know what that one changed. An app that has not updated yet may not show all of it.\n\n${whatsNew}`,
  });

const readSkill = (name: (typeof SKILL_NAMES)[number]): string => {
  const text = readFileSync(new URL(`./skills/${name}.md`, import.meta.url), "utf8");
  return name === "j3-app" ? text.replace(RELEASE_NOTES, () => releaseNotes(release)) : text;
};

/** The skills J3 Bots ships, as their `SKILL.md` files. */
export const sharedSkills: ReadonlyArray<SharedSkill> = SKILL_NAMES.map((name) => ({
  name,
  text: readSkill(name),
}));
