// SPDX-License-Identifier: AGPL-3.0-or-later
import * as Schema from "effect/Schema";
import { Label, OpenLiterals, SkillName } from "./base.ts";
import { Avatar, ModelChoice, PermissionMode, Profile } from "./bot.ts";
import { RoutineInstruction } from "./routine.ts";

// ---------------------------------------------------------------------------
// Bot templates (docs/decisions/0023-a-bot-template-is-a-file.md)
//
// A template is how a bot travels from one J3 Bots to another: what the bot
// is and does, never what it has lived. It holds the profile, the job, the
// model and permission mode it ran with, its own skills and its recurring
// routines. The job, the skills and the routines' instructions go as they are
// written, which may be by the bot itself, so whoever shares one reviews them.
// Memory, conversations, files, credentials, paths, devices and anything else
// of the machine it came from stay behind: the export builds the template
// from those fields alone, so nothing else can reach one.
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

/** A skill as a template carries it: its name and its `SKILL.md`, the one file of its folder that travels. */
export const TemplateSkill = Schema.Struct({
  name: SkillName,
  text: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(TEMPLATE_LIMITS.skillText)),
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

const encodeTemplate = Schema.encodeSync(BotTemplate);

/** The template as its file holds it: indented JSON, readable in any editor. */
export const templateFileText = (template: BotTemplate): string =>
  `${JSON.stringify(encodeTemplate(template), null, 2)}\n`;

/** How many bytes `text` takes in a file, as UTF-8: what the size limit counts. */
export const fileBytes = (text: string): number => new TextEncoder().encode(text).length;

/** A part of a template an operator can shorten: its job, or one skill or routine. */
export const TemplatePart = Schema.Union([
  Schema.TaggedStruct("job", {}),
  Schema.TaggedStruct("skill", { name: SkillName }),
  Schema.TaggedStruct("routine", { name: Label }),
]);
export type TemplatePart = typeof TemplatePart.Type;

/**
 * The bot's template would make a file over `MAX_TEMPLATE_FILE_SIZE`, which
 * no J3 Bots would read. Its text fits the template's limits, which count
 * characters, but takes more bytes than a file can hold: text in a script of
 * several bytes a character does. `largest` is the part to shorten first.
 */
export class TemplateTooLarge extends Schema.TaggedError<TemplateTooLarge>()("TemplateTooLarge", {
  /** The file's size, in bytes. */
  size: Schema.Int,
  largest: TemplatePart,
}) {
  override get message(): string {
    return `The template file would be ${this.size} bytes, over the ${MAX_TEMPLATE_FILE_SIZE} a template file can be.`;
  }
}

/** The bytes a part takes in the file, as JSON writes its text. */
const partBytes = (text: string): number => fileBytes(JSON.stringify(text));

/** The part of `template` that takes the most of its file. */
const largestPart = (template: BotTemplate): TemplatePart => {
  let largest: TemplatePart = { _tag: "job" };
  let most = partBytes(template.profile.job);
  for (const skill of template.skills) {
    const bytes = partBytes(skill.text);
    if (bytes > most) [largest, most] = [{ _tag: "skill", name: skill.name }, bytes];
  }
  for (const routine of template.routines) {
    const bytes = partBytes(routine.instruction);
    if (bytes > most) [largest, most] = [{ _tag: "routine", name: routine.name }, bytes];
  }
  return largest;
};

/**
 * Why `template` cannot be shared: its file would be over the size any J3
 * Bots reads, measured as the file is written. None when it fits.
 */
export const templateTooLarge = (template: BotTemplate): TemplateTooLarge | null => {
  const size = fileBytes(templateFileText(template));
  return size > MAX_TEMPLATE_FILE_SIZE
    ? new TemplateTooLarge({ size, largest: largestPart(template) })
    : null;
};

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
