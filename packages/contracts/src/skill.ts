// SPDX-License-Identifier: AGPL-3.0-or-later
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Rpc from "effect/rpc/Rpc";
import * as RpcGroup from "effect/rpc/RpcGroup";
import { BotId, CommandId, NonNegativeInt, SkillName } from "./base.ts";
import { CommandError } from "./errors.ts";
import { TEMPLATE_LIMITS } from "./template.ts";

/**
 * Who made a change to an MCP server or a skill: the operator, from a client,
 * or a bot, with its tools (decision 0049).
 */
export const ChangeAuthor = Schema.Union([
  Schema.TaggedStruct("operator", {}),
  Schema.TaggedStruct("bot", { botId: BotId }),
]);
export type ChangeAuthor = typeof ChangeAuthor.Type;

/** The latest change to an MCP server or a skill: who made it, and when. */
export const LastChange = Schema.Struct({ by: ChangeAuthor, at: Schema.DateTimeUtc });
export type LastChange = typeof LastChange.Type;

/**
 * The limits of a skill, the same for the operator and for a bot. Its
 * `SKILL.md` is a template skill's (decision 0023); the files beside it, its
 * scripts and references, are counted and measured whole. Each scope holds at
 * most `perScope` skills, J3 Bots' own shipped ones aside.
 */
export const SKILL_LIMITS = {
  text: TEMPLATE_LIMITS.skillText,
  description: 1_024,
  files: 64,
  pathLength: 200,
  bytes: 2 * 1024 * 1024,
  perScope: 64,
} as const;

/**
 * Where a skill lives: in one bot's workspace, which only that bot's harness
 * lists, or among the shared skills every bot's harness lists.
 */
export const SkillScope = Schema.Union([
  Schema.TaggedStruct("bot", { botId: BotId }),
  Schema.TaggedStruct("all-bots", {}),
]);
export type SkillScope = typeof SkillScope.Type;

/**
 * A public git repository a skill is installed from: an `https:` address with
 * no user name, password, query or fragment.
 */
export const GitRepository = Schema.String.check(
  Schema.isMaxLength(2_048),
  Schema.makeFilter(
    (text) => {
      if (!URL.canParse(text)) return "an https: address";
      const url = new URL(text);
      return (
        (url.protocol === "https:" &&
          url.username === "" &&
          url.password === "" &&
          url.search === "" &&
          url.hash === "") ||
        "an https: address with no user, password, query or fragment"
      );
    },
    { expected: "a public git repository's https: address" },
  ),
);
export type GitRepository = typeof GitRepository.Type;

/**
 * The folder of a repository a skill is, from its root: segments of letters,
 * digits, `.`, `_` and `-` that are not `.` or `..`, joined by `/`; empty for
 * the root itself.
 */
export const RepositoryPath = Schema.String.check(
  Schema.isMaxLength(SKILL_LIMITS.pathLength),
  Schema.makeFilter(
    (text) =>
      text === "" ||
      text
        .split("/")
        .every(
          (segment) => /^[A-Za-z0-9._-]+$/.test(segment) && segment !== "." && segment !== "..",
        ) ||
      "folder names joined by /, with no . or .. among them",
  ),
);
export type RepositoryPath = typeof RepositoryPath.Type;

/** A git commit, as its full hexadecimal id. */
export const CommitId = Schema.String.check(Schema.isPattern(/^[0-9a-f]{40}$|^[0-9a-f]{64}$/));
export type CommitId = typeof CommitId.Type;

/**
 * What a branch, a tag or a commit is named by when a skill is installed: a
 * full commit id, or a name git would take for a branch or a tag.
 */
export const GitRef = Schema.String.check(
  Schema.isPattern(/^(?!-)(?!.*\.\.)(?!.*\/\/)(?!.*@\{)[A-Za-z0-9._/@+-]{1,200}(?<![./])$/),
);
export type GitRef = typeof GitRef.Type;

/**
 * Where a skill came from: written, by the operator or a bot, or installed
 * from a repository at `commit`, recorded when it was fetched. A skill
 * installed and then edited is `written`.
 */
export const SkillSource = Schema.Union([
  Schema.TaggedStruct("written", {}),
  Schema.TaggedStruct("git", { repository: GitRepository, path: RepositoryPath, commit: CommitId }),
]);
export type SkillSource = typeof SkillSource.Type;

/**
 * A skill as clients list it. `description` is its frontmatter's, which is
 * what a harness offers the model. `shipped` marks a skill J3 Bots installs
 * itself (`j3-…`), which nobody changes. `source` and `lastChange` are null
 * for a skill J3 Bots holds no record of: one put in its folder by hand, or
 * made before records were kept.
 */
export const Skill = Schema.Struct({
  name: SkillName,
  scope: SkillScope,
  description: Schema.String.check(Schema.isMaxLength(SKILL_LIMITS.description)),
  /** The files beside its `SKILL.md`. */
  files: NonNegativeInt,
  shipped: Schema.Boolean,
  source: Schema.NullOr(SkillSource),
  lastChange: Schema.NullOr(LastChange),
});
export type Skill = typeof Skill.Type;

/** A skill's `SKILL.md`, as the operator edits it. */
export const SkillText = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(SKILL_LIMITS.text),
);
export type SkillText = typeof SkillText.Type;

/** What a harness lists a skill by, from its `SKILL.md`'s frontmatter. */
export interface SkillFrontmatter {
  readonly name: string;
  readonly description: string;
}

/** A frontmatter value: plain, or quoted in `'…'` (with `''` for `'`) or `"…"`. */
const scalar = (raw: string): string | undefined => {
  const value = raw.trim();
  if (value.startsWith("'")) {
    return value.length > 1 && value.endsWith("'")
      ? value.slice(1, -1).replaceAll("''", "'")
      : undefined;
  }
  if (value.startsWith('"')) {
    if (value.length < 2 || !value.endsWith('"')) return undefined;
    try {
      const parsed: unknown = JSON.parse(value);
      return typeof parsed === "string" ? parsed : undefined;
    } catch {
      return undefined;
    }
  }
  return value.replace(/\s+#.*$/, "");
};

/**
 * The `name` and `description` of a `SKILL.md`, as the harnesses read them
 * (the Agent Skills format): YAML frontmatter between two `---` lines at the
 * very top, with both keys at its top level. A value is one line, plain or
 * quoted, or a folded (`>`) or literal (`|`) block of the indented lines
 * below it, which harnesses read as one description. A string says what is
 * wrong when the text has no such frontmatter.
 */
export const skillFrontmatter = (text: string): SkillFrontmatter | string => {
  const lines = text.replaceAll("\r\n", "\n").split("\n");
  if (lines[0] !== "---") return "SKILL.md must open with a --- line, then its frontmatter";
  const end = lines.indexOf("---", 1);
  if (end < 0) return "SKILL.md's frontmatter must end with a --- line";
  const found = new Map<string, string>();
  for (let at = 1; at < end; at++) {
    const line = lines[at] ?? "";
    const key = /^(name|description):(.*)$/.exec(line);
    if (key === null) continue;
    const [, field = "", rest = ""] = key;
    if (/^\s*[>|][+-]?\s*$/.test(rest)) {
      const block: Array<string> = [];
      while (at + 1 < end && /^(\s+\S|\s*$)/.test(lines[at + 1] ?? "")) {
        block.push((lines[++at] ?? "").trim());
      }
      found.set(field, block.filter((each) => each !== "").join(" "));
    } else {
      const value = scalar(rest);
      if (value === undefined)
        return `The ${field} in SKILL.md's frontmatter is a quoted value that cannot be read`;
      found.set(field, value);
    }
  }
  const name = found.get("name");
  const description = found.get("description");
  if (name === undefined || name === "") return "SKILL.md's frontmatter needs a name";
  if (description === undefined || description === "") {
    return "SKILL.md's frontmatter needs a description of when the skill applies";
  }
  if (description.length > SKILL_LIMITS.description) {
    return `SKILL.md's description must be at most ${SKILL_LIMITS.description} characters`;
  }
  return { name, description };
};

const command = { commandId: CommandId };

/**
 * Skills (docs/architecture/server.md, "Skills"): the operator's side of what
 * bots do with `save_skill`, `install_skill` and `remove_skill`, under the
 * same rules. A change made here is recorded as the operator's.
 */
export const SkillRpcs = RpcGroup.make(
  /** Every skill, then the whole list again on every change. */
  Rpc.make("skills.subscribe", {
    success: Schema.Array(Skill),
    stream: true,
  }),
  /** A skill's `SKILL.md`. `NotFound("skill")` for one that is not there. */
  Rpc.make("skill.read", {
    payload: { scope: SkillScope, name: SkillName },
    success: SkillText,
    error: CommandError,
  }),
  /**
   * Writes the skill's `SKILL.md`, creating the skill or replacing that file
   * of it; its other files stay. The text must open with frontmatter whose
   * `name` is the skill's and whose `description` says when it applies
   * (`Invalid("skill-text")`). Fails with `Conflict("skill-shipped")` for a
   * name J3 Bots ships, `Conflict("skill-name-taken")` for a name the other
   * scope holds where a harness would list only one, and
   * `Conflict("skill-limit")` past a scope's skills.
   */
  Rpc.make("skill.save", {
    payload: { ...command, scope: SkillScope, name: SkillName, text: SkillText },
    success: Skill,
    error: CommandError,
  }),
  /**
   * Installs the folder `path` of a public git repository at `ref` as the
   * skill `name`, replacing one of that name, and records the commit it was
   * fetched at. Nothing in the repository is run. Fails with
   * `Invalid("skill-repository")` when the folder is not a skill or breaks a
   * limit, `Conflict("skill-fetch")` when the repository could not be
   * fetched, and as `skill.save` does.
   */
  Rpc.make("skill.install", {
    payload: {
      ...command,
      scope: SkillScope,
      name: SkillName,
      repository: GitRepository,
      path: RepositoryPath,
      ref: GitRef,
    },
    success: Skill,
    error: CommandError,
  }),
  /** Removes the skill and its folder. Removing one already gone succeeds. */
  Rpc.make("skill.remove", {
    payload: { ...command, scope: SkillScope, name: SkillName },
    error: CommandError,
  }),
);

/** A connector's last change, absent from a server that predates it. */
export const OptionalLastChange = Schema.NullOr(LastChange).pipe(
  Schema.withDecodingDefaultKey(Effect.succeed(null)),
);
