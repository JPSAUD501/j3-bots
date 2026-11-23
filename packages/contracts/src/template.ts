// SPDX-License-Identifier: AGPL-3.0-or-later
import * as Schema from "effect/Schema";
import { Label, OpenLiterals } from "./base.ts";
import { Avatar, ModelChoice, PermissionMode, Profile } from "./bot.ts";
import { RoutineInstruction } from "./routine.ts";

// ---------------------------------------------------------------------------
// Bot templates (docs/decisions/0023-a-bot-template-is-a-file.md)
//
// A template is how a bot travels from one J3 Bots to another: what the bot
// is and does, never what it has lived. It holds the profile, the job, the
// model and permission mode it ran with, its own skills and its recurring
// routines. Memory, conversations, files, secrets, paths, devices and
// anything else of the machine it came from stay behind: the export builds
// the template from those fields alone, so nothing else can reach one.
//
// Whoever imports one treats it as untrusted: it is decoded with this schema,
// within these limits, and creates a bot only after the operator has seen all
// of it.
// ---------------------------------------------------------------------------

/** What the file is: the first thing a reader checks. */
export const TEMPLATE_FORMAT = "j3-bots/bot-template";

/** The version this build writes and reads. */
export const TEMPLATE_VERSION = 1;

/** The template file's extension. */
export const TEMPLATE_FILE_EXTENSION = ".j3bot";

/** The media type a template file is shared with. */
export const TEMPLATE_MEDIA_TYPE = "application/vnd.j3bots.bot+json";

/** The largest template file a client reads, in bytes. A larger one is refused unread. */
export const MAX_TEMPLATE_FILE_SIZE = 1_048_576;

/** How much one template holds. */
export const TEMPLATE_LIMITS = { skills: 16, skillText: 20_000, routines: 16 } as const;

/**
 * A skill's name, which is its folder in the bot's workspace: lowercase
 * letters, digits and inner hyphens, at most 64 characters, the names
 * harnesses list skills under. It cannot hold a separator or a dot, so it can
 * never name a place outside the bot's skills.
 */
export const SkillName = Schema.String.check(
  Schema.isPattern(/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/),
);

/** A skill as a template carries it: its name and its `SKILL.md`, the one file of its folder that travels. */
export const TemplateSkill = Schema.Struct({
  name: SkillName,
  text: Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(TEMPLATE_LIMITS.skillText),
  ),
});
export type TemplateSkill = typeof TemplateSkill.Type;

/**
 * A routine's trigger as a template carries it. A schedule keeps its cron
 * and drops its time zone: it runs in the importing operator's. A webhook
 * gets a new address and secret. A one-time routine never travels.
 */
export const TemplateTrigger = Schema.Union([
  Schema.TaggedStruct("schedule", { cron: Label }),
  Schema.TaggedStruct("webhook", {}),
]);
export type TemplateTrigger = typeof TemplateTrigger.Type;

export const TemplateRoutine = Schema.Struct({
  name: Label,
  instruction: RoutineInstruction,
  trigger: TemplateTrigger,
});
export type TemplateRoutine = typeof TemplateRoutine.Type;

/** A permission mode a template suggests, open to modes added after this build. */
export const TemplatePermissionMode = OpenLiterals(PermissionMode.literals);
export type TemplatePermissionMode = typeof TemplatePermissionMode.Type;

const distinctNames = Schema.makeFilter(
  (skills: ReadonlyArray<TemplateSkill>) =>
    new Set(skills.map((skill) => skill.name)).size === skills.length ||
    "two skills with the same name",
);

export const BotTemplate = Schema.Struct({
  format: Schema.Literal(TEMPLATE_FORMAT),
  version: Schema.Literal(TEMPLATE_VERSION),
  profile: Schema.Struct({
    name: Profile.fields.name,
    title: Profile.fields.title,
    /** Any tokens: one this build does not have is replaced by a free look on import. */
    avatar: Avatar,
    job: Profile.fields.job,
  }),
  /** The model it ran on: a suggestion, taken only where the engine offers it. */
  model: ModelChoice,
  /** How much it could do without asking: a suggestion, never more than the default unless chosen. */
  permissionMode: TemplatePermissionMode,
  skills: Schema.Array(TemplateSkill).check(
    Schema.isMaxLength(TEMPLATE_LIMITS.skills),
    distinctNames,
  ),
  routines: Schema.Array(TemplateRoutine).check(Schema.isMaxLength(TEMPLATE_LIMITS.routines)),
});
export type BotTemplate = typeof BotTemplate.Type;

/** A template file's text, decoded. */
export const BotTemplateFile = Schema.fromJsonString(BotTemplate);

/** How much each permission mode lets a bot do without asking, least first. */
const PERMISSIVENESS: Record<PermissionMode, number> = {
  supervised: 0,
  "auto-accept-edits": 1,
  auto: 2,
  "full-access": 3,
};

/**
 * The permission mode a bot made from a template starts with when the
 * operator picks none: the template's, unless the default mode of the bot's
 * provider (`defaultPermissionMode`) lets it do less. A mode this build does
 * not know reads as supervised.
 */
export const templatePermissionMode = (
  suggested: TemplatePermissionMode,
  byDefault: PermissionMode,
): PermissionMode => {
  if (suggested === "unknown") return "supervised";
  return PERMISSIVENESS[suggested] <= PERMISSIVENESS[byDefault] ? suggested : byDefault;
};
