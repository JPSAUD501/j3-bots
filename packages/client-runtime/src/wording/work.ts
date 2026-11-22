// SPDX-License-Identifier: AGPL-3.0-or-later
import type { StepSummary, StepTool, WorkFoldEntry, WorkStep, WorkTool } from "@j3-bots/contracts";
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
  browser: { did: "tool.browser.did", doing: "tool.browser.doing" },
  "pull-request": { did: "tool.pullRequest.did", doing: "tool.pullRequest.doing" },
  issue: { did: "tool.issue.did", doing: "tool.issue.doing" },
  schedule: { did: "tool.schedule.did", doing: "tool.schedule.doing" },
  device: { did: "tool.device.did", doing: "tool.device.doing" },
  page: { did: "tool.page.did", doing: "tool.page.doing" },
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

/** What a turn's work did, from the step that says it best, as the roster says it. */
export function workDoneText(step: StepSummary | null, i18n: I18n): string {
  const { t } = i18n;
  if (step === null) return t("summary.workFold");
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
 * time is not known until it ends. Once the turn ends with work it handed off
 * still running, it says that. Then it says how long the turn worked, less
 * the time it waited on the operator.
 */
export function workFoldTitle(entry: WorkFoldEntry, ctx: PresentationContext): string {
  const { t } = ctx.i18n;
  const { status } = entry;
  if (status._tag === "running") return t("presence.working");
  if (status.background) return t("work.inBackground");
  const worked = Math.max(0, millisBetween(entry.createdAt, status.finishedAt) - status.waitedMs);
  const duration = shortDuration(worked, ctx.i18n);
  switch (status.ending) {
    case "completed":
      return t("work.workedFor", { duration });
    case "interrupted":
      return t("work.stoppedAfter", { duration });
    case "failed":
      return t("work.failedAfter", { duration });
  }
}
