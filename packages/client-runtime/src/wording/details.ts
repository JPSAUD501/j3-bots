// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  type Bot,
  type EngineStatus,
  MEMORY_TEXT_LIMIT,
  type MemoryPath,
  type PermissionMode,
  type Routine,
  type RoutineRun,
  type RoutineRunFailure,
} from "@j3-bots/contracts";
import type { I18n, KeyWith } from "@j3-bots/i18n";
import type { MemoryEditProblem } from "../presentation/saves.ts";
import { scheduleInWords } from "./schedule.ts";
import { dividerTime, timeInSentence, type TimeContext } from "./time.ts";

const PERMISSION_TEXT: Record<PermissionMode, readonly [KeyWith, KeyWith]> = {
  supervised: ["permission.supervised", "permission.supervised.description"],
  "auto-accept-edits": ["permission.autoAcceptEdits", "permission.autoAcceptEdits.description"],
  auto: ["permission.auto", "permission.auto.description"],
  "full-access": ["permission.fullAccess", "permission.fullAccess.description"],
};

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

/** A memory file's name as the details list it: the profile note, a period's log, or its path. */
export function memoryFileName(path: MemoryPath, { t }: I18n): string {
  if (path === "profile.md") return t("memory.profileNote");
  const log = /^log\/(.+)\.md$/.exec(path);
  return log?.[1] ? t("memory.log", { period: log[1] }) : path;
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
  /** That it is paused, or when it runs next; null when neither applies. */
  readonly status: string | null;
  /**
   * What its last run did, for `routine.lastRunWithCount` to place beside the
   * run count; `failed` is drawn in the blocked color. Null before it ran.
   */
  readonly lastRun: { readonly text: string; readonly failed: boolean } | null;
}

export function routineLines(routine: Routine, ctx: TimeContext): RoutineLines {
  const { t } = ctx.i18n;
  const words = scheduleInWords(routine.trigger, ctx);
  const expression = words === null && routine.trigger._tag === "schedule";
  const last = routine.lastRun;
  return {
    schedule: words ?? (routine.trigger._tag === "schedule" ? routine.trigger.cron : ""),
    expression,
    status: !routine.enabled
      ? t("routine.paused")
      : routine.nextRunAt
        ? t("routine.next", { when: timeInSentence(routine.nextRunAt, ctx) })
        : null,
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
  /** Why it failed or was skipped; null when it needs no reason. */
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
        : null,
    attempts: run.attempts > 1 ? plural("routine.run.attempts", run.attempts) : null,
    failed,
  };
}
