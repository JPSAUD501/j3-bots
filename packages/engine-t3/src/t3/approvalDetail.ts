// SPDX-License-Identifier: AGPL-3.0-or-later
import { APPROVAL_TEXT_LENGTH } from "@j3-bots/contracts";
import type { OrchestrationV2RuntimeRequest, OrchestrationV2TurnItem } from "@t3tools/contracts";
import type { EngineRequest } from "../events.ts";

// What an approval card shows, from the engine's records. The approval item
// itself carries only the provider's prompt and reason, which are text the
// provider chose: Codex puts an escalation's reason in the prompt even when it
// has the command, and a list of paths or a writable root for a file change;
// Claude Code puts the command there, or a title when the tool has none. The
// exact action lives in the item the approval holds back, which the provider
// records under the same native id: a `command_execution` with the command as
// it will run, or a `file_change` with its paths and diff. When that item is
// there, the card shows it, exact; when it is not, the prompt is all there is,
// and the card says it is a summary.
//
// One item can be held by several approvals: Codex asks for each subcommand of
// a script it runs through its shell bridge, and for input to a running
// command, under the command's item id. Such an approval has a native request
// id of its own, so the item is taken only for the approval whose request id
// is the item's.
//
// Read at db51b67: Claude Code's command item is not the command as it runs.
// `commandInputFromClaudeTool` records the Bash tool's `command` trimmed, so a
// trailing escaped space (`echo a\ `) is lost from it. Its approval prompt is
// that same `command` untrimmed, taken first under the same non-blank test;
// only a tool with no `command` gets a title instead, and the item then records
// the tool's name and its input as JSON. So a Claude Code prompt that trims to
// the item's input is the command exactly, and it is what the card shows.

type Item = OrchestrationV2TurnItem;
type ApprovalItem = Extract<Item, { type: "approval_request" }>;
type GatedItem = Extract<Item, { type: "command_execution" | "file_change" }>;
type RuntimeRequest = OrchestrationV2RuntimeRequest;
export type Approval = Extract<EngineRequest, { _tag: "approval" }>;

/** The engine's driver for Claude Code, as its items name it. Read at db51b67. */
const CLAUDE = "claudeAgent";

const KINDS: Record<ApprovalItem["requestKind"], Approval["kind"]> = {
  command: "command",
  "file-change": "file-change",
  "file-read": "file-read",
  "mcp-elicitation": "tool",
  permission: "other",
};

/** The most a reason carries, as `ApprovalEntry.reason` allows. */
const MAX_REASON = 2_000;

/**
 * A text as the engine gave it, with only its trailing line breaks dropped:
 * they show nothing. `undefined` when it is blank. `whole` is false when it was
 * longer than an approval carries, or when a dropped line break followed a
 * backslash, which would join it to the line instead of ending it.
 */
const verbatim = (text: string | null | undefined) => {
  const given = text ?? "";
  const kept = given.replace(/[\r\n]+$/, "");
  if (!/\S/.test(kept)) return undefined;
  if (kept.length > APPROVAL_TEXT_LENGTH) {
    return { text: kept.slice(0, APPROVAL_TEXT_LENGTH).replace(/[\r\n]+$/, ""), whole: false };
  }
  return { text: kept, whole: kept === given || !kept.endsWith("\\") };
};

const trimmed = (text: string | null | undefined) => {
  const kept = text?.trim() ?? "";
  return kept === "" ? undefined : kept;
};

/**
 * Whether the provider offers a grant for the session when the approval lists
 * no options. Read at db51b67: the engine's own client then offers its default
 * list, which holds "Always allow this session" whatever the kind, and every
 * adapter that leaves the options out takes `acceptForSession`: Codex for a
 * command (`item/commandExecution/requestApproval`), a file change and a
 * permission, Claude Code for any tool, through its permission suggestions.
 */
const SESSION_BY_DEFAULT: Record<ApprovalItem["requestKind"], boolean> = {
  command: true,
  "file-change": true,
  "file-read": true,
  "mcp-elicitation": true,
  permission: true,
};

/**
 * The item `approval` holds back, recorded by the same provider under the same
 * native id, when the approval asks about all of it.
 */
const gatedItem = (
  approval: ApprovalItem,
  request: RuntimeRequest | undefined,
  items: Iterable<Item>,
): GatedItem | undefined => {
  const ref = approval.nativeItemRef;
  if (ref === null || ref.nativeId === null || ref.strength !== "strong") return undefined;
  const asked = request?.nativeRequestRef;
  if (asked?.driver !== ref.driver || asked.nativeId !== ref.nativeId) return undefined;
  for (const item of items) {
    if (
      (item.type === "command_execution" || item.type === "file_change") &&
      item.runId === approval.runId &&
      item.nativeItemRef?.strength === "strong" &&
      item.nativeItemRef.driver === ref.driver &&
      item.nativeItemRef.nativeId === ref.nativeId
    ) {
      return item;
    }
  }
  return undefined;
};

interface Shown {
  readonly action: string;
  readonly detail: string | null;
  readonly exact: boolean;
}

/** The command `gated` runs, as `approval` gives it. */
const commandOf = (approval: ApprovalItem, gated: GatedItem & { type: "command_execution" }) =>
  gated.nativeItemRef?.driver === CLAUDE
    ? approval.prompt?.trim() === gated.input
      ? approval.prompt
      : undefined
    : gated.input;

/** What the held item says exactly, or `undefined` when it does not say what was asked. */
const exactOf = (
  kind: Approval["kind"],
  approval: ApprovalItem,
  gated: GatedItem,
): Shown | undefined => {
  if (kind === "command" && gated.type === "command_execution") {
    const command = verbatim(commandOf(approval, gated));
    return command && { action: command.text, detail: null, exact: command.whole };
  }
  if (kind === "file-change" && gated.type === "file_change") {
    const changes = gated.changes ?? [];
    const paths = verbatim(
      changes.length === 0
        ? gated.fileName
        : changes
            .map((change) =>
              change.oldPath === undefined ? change.path : `${change.oldPath} → ${change.path}`,
            )
            .join("\n"),
    );
    if (paths === undefined) return undefined;
    // A diff covers one file, so with several changes it shows only part of them.
    const diff = changes.length <= 1 ? verbatim(gated.diffStr) : undefined;
    return {
      action: paths.text,
      detail: diff?.text ?? null,
      exact: diff !== undefined && diff.whole && paths.whole,
    };
  }
  return undefined;
};

/**
 * The approval card's content for an engine approval item and the runtime
 * request it answers, when the engine has recorded it. `items` are the other
 * items of its thread, among which the provider may have recorded the action
 * it holds back.
 */
export function approvalOf(
  approval: ApprovalItem,
  request: RuntimeRequest | undefined,
  items: Iterable<Item>,
): Approval {
  const kind = KINDS[approval.requestKind];
  const gated = gatedItem(approval, request, items);
  const exact = gated === undefined ? undefined : exactOf(kind, approval, gated);
  const prompt = verbatim(approval.prompt);
  const summary = prompt ?? verbatim(approval.title);
  // A held file change with no diff gives its paths, but not the change: the
  // provider's own words say more about it, so they stay the summary.
  const shown: Shown = exact?.exact
    ? exact
    : {
        action: summary?.text ?? exact?.action ?? "Approval",
        detail: null,
        exact: false,
      };
  // The prompt, when the action came from elsewhere and the prompt says
  // something else, is the provider's reason for asking. The action is compared
  // as shown, untrimmed.
  const reasons = [
    trimmed(approval.reason),
    shown.exact && approval.prompt !== shown.action ? trimmed(approval.prompt) : undefined,
  ].filter((text): text is string => text !== undefined && text !== shown.action);
  const reason = [...new Set(reasons)].join("\n\n").slice(0, MAX_REASON).trim();
  // A grant for the session allows what is asked again, unseen, so it is offered only for an
  // action shown exactly, and only when the provider takes one.
  const sessionOffered =
    approval.options === undefined
      ? SESSION_BY_DEFAULT[approval.requestKind]
      : approval.options.some((option) => option.decision === "acceptForSession");
  return {
    _tag: "approval",
    kind,
    ...shown,
    reason: reason === "" ? null : reason,
    allowsSession: shown.exact && sessionOffered,
  };
}
