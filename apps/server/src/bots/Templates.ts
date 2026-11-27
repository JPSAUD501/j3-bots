// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  type BotId,
  type BotTemplate,
  NotFound,
  type Routine,
  TEMPLATE_FORMAT,
  TEMPLATE_LIMITS,
  TEMPLATE_VERSION,
  TemplateSkill,
  type TemplateRoutine,
  type TemplateTooLarge,
  templateTooLarge,
} from "@j3-bots/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { WORKSPACE_ENTRIES } from "../home/entries.ts";
import { Routines } from "../routines/Routines.ts";
import { BotStore } from "./BotStore.ts";

/** The file of a skill's folder a template carries. */
export const SKILL_FILE = "SKILL.md";

/**
 * The most bytes a `SKILL.md` within the template's limit can take: four per
 * UTF-16 code unit at most, so a file over it is passed over unread.
 */
const MAX_SKILL_BYTES = TEMPLATE_LIMITS.skillText * 4;

const decodeSkill = Schema.decodeUnknownOption(TemplateSkill);

/**
 * A routine as a template carries it; none for a one-time routine, which
 * never travels, nor for one on a connector's event, whose connector is the
 * operator's own.
 */
const templateRoutine = (routine: Routine): Option.Option<TemplateRoutine> => {
  const { name, instruction, trigger } = routine;
  switch (trigger._tag) {
    case "schedule":
      return Option.some({ name, instruction, trigger: { _tag: "schedule", cron: trigger.cron } });
    case "webhook":
      return Option.some({ name, instruction, trigger: { _tag: "webhook" } });
    case "once":
    case "event":
      return Option.none();
  }
};

/**
 * Bots as templates (`docs/decisions/0023-a-bot-template-is-a-file.md`). A
 * template is built from named fields of the bot, its routines and its own
 * skills, never from a copy of anything larger, so what it leaves out cannot
 * reach it: memory, the conversation, files, the workspace's paths, the
 * webhook secrets and the routines' time zones.
 */
export class Templates extends Context.Service<
  Templates,
  {
    /**
     * The bot as a template. Its skills are read from its workspace as it was
     * first provisioned: each folder of `skills/` named as a skill, in name
     * order, that is a real folder holding a `SKILL.md` that is a regular file
     * within the limits. A link is never followed, and what cannot be read is
     * passed over. Skills and routines past the template's limits stay out.
     * The job, the skills and the routines' instructions go as written. A
     * template whose file would be over the size a client reads is refused,
     * naming its largest part, rather than shared and then refused unread.
     */
    readonly template: (botId: BotId) => Effect.Effect<BotTemplate, NotFound | TemplateTooLarge>;
  }
>()("@j3-bots/server/bots/Templates") {}

export const layer = Layer.effect(
  Templates,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const store = yield* BotStore;
    const routines = yield* Routines;

    /** What is at `location`, links not followed; none when it cannot be read. */
    const kindOf = (location: string) => fs.lstat(location).pipe(Effect.option);

    const readSkill = Effect.fnUntraced(function* (folder: string, name: string) {
      const dir = path.join(folder, name);
      const dirInfo = yield* kindOf(dir);
      if (Option.isNone(dirInfo) || dirInfo.value.type !== "Directory") return Option.none();
      const file = path.join(dir, SKILL_FILE);
      const info = yield* kindOf(file);
      if (Option.isNone(info) || info.value.type !== "File") return Option.none();
      if (Number(info.value.size) > MAX_SKILL_BYTES) return Option.none();
      const text = yield* fs.readFileString(file).pipe(Effect.option);
      return Option.flatMap(text, (read) => decodeSkill({ name, text: read }));
    });

    const readSkills = Effect.fnUntraced(function* (workspace: Option.Option<string>) {
      if (Option.isNone(workspace)) return [];
      const folder = path.join(workspace.value, WORKSPACE_ENTRIES.skills);
      const info = yield* kindOf(folder);
      if (Option.isNone(info) || info.value.type !== "Directory") return [];
      const names = yield* fs.readDirectory(folder).pipe(Effect.orElseSucceed(() => []));
      const skills: Array<TemplateSkill> = [];
      for (const name of [...names].sort()) {
        if (skills.length === TEMPLATE_LIMITS.skills) break;
        const skill = yield* readSkill(folder, name);
        if (Option.isSome(skill)) skills.push(skill.value);
      }
      return skills;
    });

    const template = Effect.fn("Templates.template")(function* (botId: BotId) {
      const stored = yield* store.find(botId);
      if (Option.isNone(stored)) return yield* new NotFound({ resource: "bot" });
      const { bot, workspaceRoot } = stored.value;
      const kept = (yield* routines.list(botId))
        .flatMap((routine) => Option.toArray(templateRoutine(routine)))
        .slice(0, TEMPLATE_LIMITS.routines);
      const built: BotTemplate = {
        format: TEMPLATE_FORMAT,
        version: TEMPLATE_VERSION,
        profile: {
          name: bot.profile.name,
          title: bot.profile.title,
          avatar: bot.profile.avatar,
          job: bot.profile.job,
        },
        model: bot.model,
        permissionMode: bot.permissionMode,
        skills: yield* readSkills(workspaceRoot),
        routines: kept,
      };
      const tooLarge = templateTooLarge(built);
      if (tooLarge !== null) return yield* tooLarge;
      return built;
    });

    return Templates.of({ template });
  }),
);
