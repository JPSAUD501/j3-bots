// SPDX-License-Identifier: AGPL-3.0-or-later
import type {
  StepSummary,
  StepTool,
  TurnEnding,
  WorkFoldEntry,
  WorkStep,
  WorkTool,
} from "@j3-bots/contracts";
import type { I18n, KeyWith } from "@j3-bots/i18n";
import { millisBetween, shortDuration } from "../presentation/time.ts";
import { firstLine } from "../presentation/roster.ts";
import type { PresentationContext } from "./status.ts";

type Phrase = KeyWith<never>;

/**
 * Every tool the operator can meet, in J3 Bots' words: what a step that used
 * it did, and what a bot doing it now is doing. The one place a client names
 * a tool; a tool it cannot name keeps the readable name its step carries.
 */
const toolWords: Record<WorkTool, { readonly did: Phrase; readonly doing: Phrase }> = {
  "background-task": { did: "tool.backgroundTask.did", doing: "tool.backgroundTask.doing" },
  "task-status": { did: "tool.taskStatus.did", doing: "tool.taskStatus.doing" },
  "task-stop": { did: "tool.taskStop.did", doing: "tool.taskStop.doing" },
  secret: { did: "tool.secret.did", doing: "tool.secret.doing" },
  connector: { did: "tool.connector.did", doing: "tool.connector.doing" },
  browser: { did: "tool.browser.did", doing: "tool.browser.doing" },
  "pull-request": { did: "tool.pullRequest.did", doing: "tool.pullRequest.doing" },
  issue: { did: "tool.issue.did", doing: "tool.issue.doing" },
  schedule: { did: "tool.schedule.did", doing: "tool.schedule.doing" },
  device: { did: "tool.device.did", doing: "tool.device.doing" },
  "web-page": { did: "tool.webPage.did", doing: "tool.webPage.doing" },
  plan: { did: "tool.plan.did", doing: "tool.plan.doing" },
  image: { did: "tool.image.did", doing: "tool.image.doing" },
  "built-in": { did: "tool.builtIn.did", doing: "tool.builtIn.doing" },
};

/** The tool's words, or none for a tool this build cannot name. */
const wordsOf = (tool: StepTool) => (tool === null || tool === "unknown" ? null : toolWords[tool]);

/**
 * A step as its row in the work fold says it: the tool in J3 Bots' words,
 * what it is doing while it runs and what it did once it ran; else the
 * step's own label, a command or a path.
 */
export function stepText(step: WorkStep, i18n: I18n): string {
  const words = wordsOf(step.tool);
  if (words === null) return step.label;
  return i18n.t(step.status === "running" ? words.doing : words.did);
}

/**
 * What a working bot is doing, in a few words: its running step's tool,
 * else that step's label, else that it is working.
 */
export function activityText(activity: string | null, tool: StepTool, i18n: I18n): string {
  const words = wordsOf(tool);
  if (words !== null) return i18n.t(words.doing);
  return activity ?? i18n.t("presence.working");
}

/**
 * What a turn's work did, from the step that says it best, as the roster says
 * it. With no step, a turn stopped or failed before its first says only that.
 */
export function workDoneText(
  step: StepSummary | null,
  ending: TurnEnding | null,
  i18n: I18n,
): string {
  const { t } = i18n;
  if (step === null) {
    if (ending === "interrupted") return t("summary.workStopped");
    if (ending === "failed") return t("summary.workFailed");
    return t("summary.workFold");
  }
  const words = wordsOf(step.tool);
  if (words !== null) return t(words.did);
  const label = firstLine(step.label);
  switch (step.kind) {
    case "command":
      return t("summary.ran", { label });
    case "edit":
      return t("summary.edited", { label });
    case "read":
      return t("summary.read", { label });
    case "search":
      return t("summary.searched", { label });
    case "web":
      return t("summary.searchedWeb", { label });
    case "delegation":
      return t("summary.handedOff", { label });
    case "tool":
      return t("summary.usedTool", { label });
    case "other":
      return label;
  }
}

/**
 * A work fold's title. While the turn runs it says so, with no duration: the
 * time is not known until it ends. Once the turn has completed with work it
 * handed off still running, it says that. Otherwise it says how the turn
 * ended and how long it worked, from the turn's start, as its clock counted,
 * less the time it waited on the operator; a turn stopped or failed says so
 * even while work it handed off still runs, and then says that too.
 */
export function workFoldTitle(entry: WorkFoldEntry, ctx: PresentationContext): string {
  const { t } = ctx.i18n;
  const { status } = entry;
  if (status._tag === "running") return t("presence.working");
  if (status.background && status.ending === "completed") return t("work.inBackground");
  // From the turn's start, less every wait since; from an older server, from the fold's first step.
  const waited =
    entry.turnStartedAt === null ? status.waitedMs : status.waitedMs + status.waitedBeforeMs;
  const from = entry.turnStartedAt ?? entry.createdAt;
  const worked = Math.max(0, millisBetween(from, status.finishedAt) - waited);
  const duration = shortDuration(worked, ctx.i18n);
  switch (status.ending) {
    case "completed":
      return t("work.workedFor", { duration });
    case "interrupted":
      return t(status.background ? "work.stoppedAfterInBackground" : "work.stoppedAfter", {
        duration,
      });
    case "failed":
      return t(status.background ? "work.failedAfterInBackground" : "work.failedAfter", {
        duration,
      });
  }
}
