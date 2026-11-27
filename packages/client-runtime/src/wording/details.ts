// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  type Bot,
  type EffortChoice,
  type EngineStatus,
  MAX_TEMPLATE_FILE_SIZE,
  MEMORY_TEXT_LIMIT,
  MISSED_RUNS_LIMIT,
  type MemoryPath,
  type PermissionMode,
  type Routine,
  type RoutineRun,
  type RoutineMissed,
  type RoutineRunFailure,
  type TemplatePart,
  type TemplateTooLarge,
} from "@j3-bots/contracts";
import type { AvatarShapeName, BotColor } from "@j3-bots/design-tokens/names";
import type { I18n, KeyWith } from "@j3-bots/i18n";
import type { MemoryEditProblem } from "../presentation/saves.ts";
import type { TemplateRead } from "../presentation/template.ts";
import { millisBetween, shortDuration } from "../presentation/time.ts";
import { fileSize } from "./message.ts";
import { eventInWords, eventStopText, scheduleInWords } from "./schedule.ts";
import { dividerTime, timeInSentence, type TimeContext } from "./time.ts";

const PERMISSION_TEXT: Record<PermissionMode, readonly [KeyWith, KeyWith]> = {
  supervised: ["permission.supervised", "permission.supervised.description"],
  "auto-accept-edits": ["permission.autoAcceptEdits", "permission.autoAcceptEdits.description"],
  auto: ["permission.auto", "permission.auto.description"],
  "full-access": ["permission.fullAccess", "permission.fullAccess.description"],
};

/** An avatar silhouette's name, as a picker reads it out. */
export const avatarShapeText = (shape: AvatarShapeName, { t }: I18n) => t(`avatar.shape.${shape}`);

/** A bot color's name, as a picker reads it out. */
export const botColorText = (color: BotColor, { t }: I18n) => t(`avatar.color.${color}`);

/** Why a file opened as a template cannot make a bot. */
export function templateReadText(
  read: Exclude<TemplateRead, { readonly _tag: "template" }>,
  { t }: I18n,
): string {
  switch (read._tag) {
    case "too-large":
      return t("template.read.tooLarge");
    case "newer":
      return t("template.read.newer");
    case "invalid":
      return t("template.read.invalid");
    case "unreadable":
      return t("template.read.unreadable");
  }
}

const templatePartText = (part: TemplatePart, { t }: I18n): string => {
  switch (part._tag) {
    case "job":
      return t("template.part.job");
    case "skill":
      return t("template.part.skill", { name: part.name });
    case "routine":
      return t("template.part.routine", { name: part.name });
  }
};

/** Why `name` cannot be shared as a template: its file would be over the limit, and what to shorten. */
export function templateTooLargeText(name: string, error: TemplateTooLarge, i18n: I18n): string {
  return i18n.t("template.share.tooLarge", {
    name,
    limit: fileSize(MAX_TEMPLATE_FILE_SIZE, i18n.locale),
    part: templatePartText(error.largest, i18n),
  });
}

/** The levels of effort clients have words of their own for (`effortText`). */
const NAMED_EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
type NamedEffort = (typeof NAMED_EFFORTS)[number];
const namedEffort = (id: string): NamedEffort | undefined =>
  NAMED_EFFORTS.find((named) => named === id);

/**
 * A level of effort as a picker names it, null being the default: in the
 * interface's words for a level they have, else as the engine names it.
 */
export function effortText(level: EffortChoice | null, { t }: I18n): string {
  if (level === null) return t("editBot.effort.level.default");
  const named = namedEffort(level.id);
  return named === undefined ? level.name : t(`editBot.effort.level.${named}`);
}

/** A permission mode's name, and what it lets a bot do. */
export function permissionModeText(
  mode: PermissionMode,
  { t }: I18n,
): { readonly name: string; readonly description: string } {
  const [name, description] = PERMISSION_TEXT[mode];
  return { name: t(name), description: t(description) };
}

/**
 * The model a bot runs on, with its provider, as the engine names them:
 * "Claude · Opus 5.5". Null when the engine does not offer it now.
 */
export function botModelName(engine: EngineStatus | null, bot: Bot): string | null {
  const provider = engine?.providers.find((p) => p.id === bot.model.providerId);
  const model = provider?.models.find((m) => m.id === bot.model.modelId);
  return provider && model ? `${provider.name} · ${model.name}` : null;
}

/**
 * A memory file's name as the details list it: the profile, a month's notes
 * with the month in words ("Notes from November 2026"), or its path.
 */
export function memoryFileName(path: MemoryPath, { t, locale }: I18n): string {
  if (path === "profile.md") return t("memory.profileNote");
  const log = /^log\/(\d{4})-(\d{2})\.md$/.exec(path);
  if (log === null) return path;
  const month = Number(log[2]);
  if (month < 1 || month > 12) return path;
  const words = new Intl.DateTimeFormat(locale, {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(Date.UTC(Number(log[1]), month - 1, 1));
  return t("memory.log", { month: words });
}

const MEMORY_PROBLEM_TEXT = {
  "reload-failed": "memory.reloadFailed",
  stale: "memory.stale",
  "private-location": "memory.privateLocation",
  gone: "memory.gone",
  model: "memory.saveFailed",
  failed: "memory.saveFailed",
} as const;

/** What a memory file's edit says is wrong. */
export function memoryEditProblemText(problem: MemoryEditProblem, { t }: I18n): string {
  return problem === "too-long"
    ? t("memory.tooLong", { max: MEMORY_TEXT_LIMIT })
    : t(MEMORY_PROBLEM_TEXT[problem]);
}

/** What a routine's last run did; a row adds the run count around it. */
const LAST_RUN_TEXT: Record<NonNullable<Routine["lastRun"]>["status"], KeyWith<"when">> = {
  running: "routine.lastRun.running",
  delivered: "routine.lastRun.delivered",
  silent: "routine.lastRun.silent",
  failed: "routine.lastRun.failed",
  skipped: "routine.lastRun.skipped",
};

/** What a routine's last run did, with why it failed when the server names it. */
function lastRunText(run: NonNullable<Routine["lastRun"]>, ctx: TimeContext): string {
  const { t } = ctx.i18n;
  const when = timeInSentence(run.startedAt, ctx);
  const failure = run.status === "failed" ? run.failure : undefined;
  if (failure === undefined) return t(LAST_RUN_TEXT[run.status], { when });
  const mode = permissionModeText(failure.permissionMode, ctx.i18n).name;
  return failure.allowed === null
    ? t("routine.lastRun.modeRefused", { when, mode })
    : t("routine.lastRun.modeAllowed", {
        when,
        mode,
        allowed: permissionModeText(failure.allowed, ctx.i18n).name,
      });
}

/** A routine as its row in the details says it. */
export interface RoutineLines {
  /** Its trigger in words, or a schedule's expression when it has no plain sentence. */
  readonly schedule: string;
  /** `schedule` is the expression itself, drawn as code. */
  readonly expression: boolean;
  /**
   * That it is paused, or when it runs next, after the runs it missed while
   * J3 Bots was not running; for a routine on a connector's event, that J3
   * Bots waits for the connector or stopped listening, and why. Null when
   * none of them applies. `blocked` is drawn in the blocked color.
   */
  readonly status: { readonly text: string; readonly blocked: boolean } | null;
  /**
   * What its last run did, for `routine.lastRunWithCount` to place beside the
   * run count; `failed` is drawn in the blocked color. Null before it ran.
   */
  readonly lastRun: { readonly text: string; readonly failed: boolean } | null;
}

/**
 * The runs a routine missed. The server cannot tell a computer asleep from
 * one shut down or a crash, so the words say only that J3 Bots was not
 * running.
 */
function missedText(missed: RoutineMissed, { i18n }: TimeContext): string {
  return missed.count >= MISSED_RUNS_LIMIT
    ? i18n.t("routine.missedAtLeast", { count: MISSED_RUNS_LIMIT })
    : i18n.plural("routine.missed", missed.count);
}

/** That it is paused, how it listens for its event, or the runs it missed and when it runs next. */
function routineStatus(routine: Routine, ctx: TimeContext): RoutineLines["status"] {
  const { t } = ctx.i18n;
  if (!routine.enabled) return { text: t("routine.paused"), blocked: false };
  const listening = routine.listening;
  if (listening !== undefined) {
    const connector = routine.connectorName ?? null;
    switch (listening._tag) {
      case "listening":
        return null;
      case "waiting":
        return {
          text: t("routine.waiting", { connector: connector ?? t("routine.theConnector") }),
          blocked: false,
        };
      case "stopped": {
        const reason = eventStopText(listening.reason, connector, ctx.i18n);
        return {
          text: reason === null ? t("routine.stoppedUnknown") : t("routine.stopped", { reason }),
          blocked: true,
        };
      }
    }
  }
  const text = clockStatus(routine, ctx);
  return text === null ? null : { text, blocked: false };
}

/** When a routine runs next, after the runs it missed while J3 Bots was not running. */
function clockStatus(routine: Routine, ctx: TimeContext): string | null {
  const { t } = ctx.i18n;
  const next =
    routine.nextRunAt === null
      ? null
      : t("routine.next", { when: timeInSentence(routine.nextRunAt, ctx) });
  const missed = routine.missed ? missedText(routine.missed, ctx) : null;
  if (missed === null) return next;
  return next === null ? missed : t("routine.missedThenNext", { missed, next });
}

export function routineLines(routine: Routine, ctx: TimeContext): RoutineLines {
  const { trigger } = routine;
  const words =
    trigger._tag === "event"
      ? eventInWords(trigger, routine.connectorName ?? null, ctx.i18n)
      : scheduleInWords(trigger, ctx);
  const expression = words === null && trigger._tag === "schedule";
  const last = routine.lastRun;
  return {
    schedule: words ?? (trigger._tag === "schedule" ? trigger.cron : ""),
    expression,
    status: routineStatus(routine, ctx),
    lastRun:
      last === null
        ? null
        : {
            text: lastRunText(last, ctx),
            failed: last.status === "failed",
          },
  };
}

const RUN_STATUS_TEXT: Record<RoutineRun["status"], KeyWith> = {
  running: "routine.run.running",
  delivered: "routine.run.delivered",
  silent: "routine.run.silent",
  failed: "routine.run.failed",
  skipped: "routine.run.skipped",
};

/** Why an attempt failed, as a sentence of its own. */
function runFailureText(failure: RoutineRunFailure, i18n: I18n): string {
  const mode = permissionModeText(failure.permissionMode, i18n).name;
  return failure.allowed === null
    ? i18n.t("routine.run.modeRefused", { mode })
    : i18n.t("routine.run.modeAllowed", {
        mode,
        allowed: permissionModeText(failure.allowed, i18n).name,
      });
}

/** One run as a routine's history lists it. */
export interface RoutineRunLines {
  /** What it did: "Reported back", "Failed". */
  readonly status: string;
  /** When it started. */
  readonly when: string;
  /** Why it failed, was skipped or ran late; null when it needs no reason. */
  readonly reason: string | null;
  /** How many attempts it took, once it took more than one. */
  readonly attempts: string | null;
  /** `status` and `reason` are drawn in the blocked color. */
  readonly failed: boolean;
}

export function routineRunLines(run: RoutineRun, ctx: TimeContext): RoutineRunLines {
  const { t, plural } = ctx.i18n;
  const failed = run.status === "failed";
  return {
    status: t(RUN_STATUS_TEXT[run.status]),
    when: dividerTime(run.startedAt, ctx),
    reason: failed
      ? run.failure === undefined
        ? t("routine.run.ended")
        : runFailureText(run.failure, ctx.i18n)
      : run.status === "skipped"
        ? t("routine.run.skippedWhy")
        : run.dueAt !== undefined
          ? t("routine.run.late", {
              duration: shortDuration(millisBetween(run.dueAt, run.startedAt), ctx.i18n),
              when: timeInSentence(run.dueAt, ctx),
            })
          : null,
    attempts: run.attempts > 1 ? plural("routine.run.attempts", run.attempts) : null,
    failed,
  };
}
