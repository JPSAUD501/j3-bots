// SPDX-License-Identifier: AGPL-3.0-or-later
import type {
  ActivityKind,
  CredentialFill,
  FillField,
  StepSummary,
  StepTool,
  TurnEnding,
  WorkFoldEntry,
  WorkStep,
  WorkStepKind,
  WorkTool,
} from "@j3-bots/contracts";
import type { I18n, KeyWith } from "@j3-bots/i18n";
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
  login: { did: "tool.login.did", doing: "tool.login.doing" },
  connector: { did: "tool.connector.did", doing: "tool.connector.doing" },
  browser: { did: "tool.browser.did", doing: "tool.browser.doing" },
  "pull-request": { did: "tool.pullRequest.did", doing: "tool.pullRequest.doing" },
  issue: { did: "tool.issue.did", doing: "tool.issue.doing" },
  schedule: { did: "tool.schedule.did", doing: "tool.schedule.doing" },
  device: { did: "tool.device.did", doing: "tool.device.doing" },
  "web-page": { did: "tool.webPage.did", doing: "tool.webPage.doing" },
  plan: { did: "tool.plan.did", doing: "tool.plan.doing" },
  image: { did: "tool.image.did", doing: "tool.image.doing" },
  "mcp-server-added": { did: "tool.mcpServerAdded.did", doing: "tool.mcpServerAdded.doing" },
  "mcp-server-changed": {
    did: "tool.mcpServerChanged.did",
    doing: "tool.mcpServerChanged.doing",
  },
  "mcp-server-removed": {
    did: "tool.mcpServerRemoved.did",
    doing: "tool.mcpServerRemoved.doing",
  },
  "mcp-servers-read": { did: "tool.mcpServersRead.did", doing: "tool.mcpServersRead.doing" },
  "skill-saved": { did: "tool.skillSaved.did", doing: "tool.skillSaved.doing" },
  "skill-removed": { did: "tool.skillRemoved.did", doing: "tool.skillRemoved.doing" },
  "skills-read": { did: "tool.skillsRead.did", doing: "tool.skillsRead.doing" },
  "built-in": { did: "tool.builtIn.did", doing: "tool.builtIn.doing" },
};

/** The tool's words, or none for a tool this build cannot name. */
const wordsOf = (tool: StepTool) => (tool === null || tool === "unknown" ? null : toolWords[tool]);

const filled: Record<FillField, KeyWith<"name">> = {
  username: "fill.filled.username",
  password: "fill.filled.password",
  totp: "fill.filled.totp",
};

const notFilled: Record<FillField, KeyWith<"name">> = {
  username: "fill.notFilled.username",
  password: "fill.notFilled.password",
  totp: "fill.notFilled.totp",
};

/**
 * Each kind of step in plain words: what a step of it did, and what a bot on
 * it is doing. A tool step has words of its own (`toolWords`, or the tool's
 * name), and a step of a kind this build does not know says only that the
 * bot worked.
 */
const kindWords: Record<
  Exclude<WorkStepKind, "tool">,
  { readonly did: Phrase; readonly doing: Phrase }
> = {
  command: { did: "step.command.did", doing: "step.command.doing" },
  edit: { did: "step.edit.did", doing: "step.edit.doing" },
  read: { did: "step.read.did", doing: "step.read.doing" },
  search: { did: "step.search.did", doing: "step.search.doing" },
  web: { did: "step.web.did", doing: "step.web.doing" },
  delegation: { did: "step.delegation.did", doing: "step.delegation.doing" },
  other: { did: "summary.workFold", doing: "presence.working" },
};

/**
 * A step in plain words, as the operator reads it wherever it is shown: what
 * it is doing while it runs, what it did once it ran. A tool J3 Bots names
 * in its words; a tool it cannot name by its own readable name; every other
 * step by its kind, never by its command, path or search, which only the
 * step's detail shows (`stepDetail`).
 */
function stepWords(
  kind: ActivityKind,
  tool: StepTool,
  label: string | null,
  running: boolean,
  i18n: I18n,
): string {
  const { t } = i18n;
  const words = wordsOf(tool);
  if (words !== null) return t(running ? words.doing : words.did);
  if (kind === "tool") {
    const name = label === null ? "" : firstLine(label);
    if (name === "") return t(running ? "tool.builtIn.doing" : "tool.builtIn.did");
    return t(running ? "step.tool.doing" : "step.tool.did", { label: name });
  }
  const plain = kind === null || kind === "unknown" ? kindWords.other : kindWords[kind];
  return t(running ? plain.doing : plain.did);
}

/** A login's fill as its step says it: the login and the field, and whether it was filled. */
export function fillText(fill: CredentialFill, i18n: I18n): string {
  return i18n.t((fill.outcome._tag === "filled" ? filled : notFilled)[fill.field], {
    name: fill.name,
  });
}

/**
 * A step as its row in the work fold says it, in plain words (`stepWords`),
 * or as its login's fill (`fillText`). `turnRuns`: the fold's turn has not
 * ended. Once it has, a step still running, work the turn handed off, reads
 * as done with the turn.
 */
export function stepText(step: WorkStep, turnRuns: boolean, i18n: I18n): string {
  if (step.fill !== undefined) return fillText(step.fill, i18n);
  const running = turnRuns && step.status === "running";
  return stepWords(step.kind, step.tool, step.label, running, i18n);
}

/**
 * What a step worked on, as it was given: the command, the path, the search
 * or the address, for whoever opens the step to see it. None for a tool,
 * whose words already say it, and for a login's fill, which says its own.
 */
export function stepDetail(step: WorkStep): string | null {
  if (step.fill !== undefined || step.kind === "tool") return null;
  return step.label;
}

/**
 * Where a login was filled, or why it was not: the page's origin as the server
 * checked it, a lookalike as its punycode, so the operator sees where a fill
 * was asked for.
 */
export function fillDetail(fill: CredentialFill, i18n: I18n): string {
  const { t } = i18n;
  const { outcome, origin } = fill;
  switch (outcome._tag) {
    case "filled":
      return origin === null
        ? outcome.submitted
          ? t("fill.submitted")
          : ""
        : t(outcome.submitted ? "fill.onSubmitted" : "fill.on", { origin });
    case "refused":
      switch (outcome.reason) {
        case "no-access":
          return t("fill.refused.noAccess");
        case "unknown-login":
          return t("fill.refused.unknownLogin");
        case "no-value":
          return t("fill.refused.noValue");
        case "no-tab":
          return t("fill.refused.noTab");
        case "held":
          return t("fill.refused.held");
        case "loading":
          return t("fill.refused.loading");
        case "insecure":
          return origin === null
            ? t("fill.refused.insecure")
            : t("fill.refused.insecureAt", { origin });
        case "origin":
          return origin === null
            ? t("fill.refused.origin")
            : t("fill.refused.originAt", { origin });
        case "navigated":
          return t("fill.refused.navigated");
        case "refused-before":
          return t("fill.refused.before");
        case "stopped":
          return t("fill.refused.stopped");
        case "unavailable":
          return t("fill.refused.unavailable");
        case "unknown":
          return t("fill.refused.other");
      }
  }
}

/** What a working bot is doing, in a few words: the step it is on, in plain words (`stepWords`). */
export function activityText(
  activity: string | null,
  kind: ActivityKind,
  tool: StepTool,
  i18n: I18n,
): string {
  return stepWords(kind, tool, activity, true, i18n);
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
  return stepWords(step.kind, step.tool, step.label, false, i18n);
}

/**
 * A work fold's title: that the turn is working, or how it ended. No time:
 * the steps beside it say what the work was.
 */
export function workFoldTitle(entry: WorkFoldEntry, ctx: PresentationContext): string {
  const { t } = ctx.i18n;
  const { status } = entry;
  if (status._tag === "running") return t("presence.working");
  switch (status.ending) {
    case "completed":
      return t("work.worked");
    case "interrupted":
      return t("work.stopped");
    case "failed":
      return t("work.failed");
  }
}
