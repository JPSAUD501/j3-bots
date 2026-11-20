// SPDX-License-Identifier: AGPL-3.0-or-later
import { APPROVAL_TEXT_LENGTH, type SessionGrant } from "@j3-bots/contracts";
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
// the item's input is the command exactly, and it is what the card shows. The
// prompt is then the action, never a reason, even where the card drops a
// trailing line break the prompt kept.

type Item = OrchestrationV2TurnItem;
type ApprovalItem = Extract<Item, { type: "approval_request" }>;
type GatedItem = Extract<Item, { type: "command_execution" | "file_change" }>;
type RuntimeRequest = OrchestrationV2RuntimeRequest;
export type Approval = Extract<EngineRequest, { _tag: "approval" }>;

/** The engine's drivers for Codex and Claude Code, as its items name them. Read at db51b67. */
const CODEX = "codex";
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
    return {
      text: kept.slice(0, APPROVAL_TEXT_LENGTH).replace(/[\r\n]+$/, ""),
      whole: false,
    };
  }
  return {
    text: kept,
    whole: kept === given || !kept.endsWith("\\"),
  };
};

/**
 * Characters the card cannot draw as they act: a carriage return, drawn like a
 * space or a line break though it is neither, and the bidi embedding, override
 * and isolate controls, which reorder the text around them on screen.
 */
const UNSHOWABLE = /[\r\u202A-\u202E\u2066-\u2069]/;

/** As `UNSHOWABLE`, except a carriage return that, with the line feed after it, ends a line. */
const UNSHOWABLE_BUT_CRLF = /\r(?!\n)|[\u202A-\u202E\u2066-\u2069]/;

const trimmed = (text: string | null | undefined) => {
  const kept = text?.trim() ?? "";
  return kept === "" ? undefined : kept;
};

/**
 * What a grant for the session allows from then on, by the provider that takes
 * it and the kind of action shown exactly. Read at db51b67:
 *
 * - Codex: `CodexAdapterV2` keeps, per provider thread and runtime mode, the
 *   request kinds granted for the session. `acceptForSession` adds "command" or
 *   "file-change", and every later request of that kind is answered
 *   `acceptForSession` without being asked (`item/commandExecution/requestApproval`,
 *   `item/fileChange/requestApproval`, and the older `execCommandApproval` and
 *   `applyPatchApproval`).
 *
 * No other provider is listed: what its grant covers is not established, so
 * none is offered. Claude Code is one: `permissionResultFromDecision` answers a
 * grant with the CLI's own permission suggestions moved to the session, which
 * can switch its permission mode (`setMode`, as to `acceptEdits`) or add
 * directories, and those suggestions never reach the approval the engine
 * records, so what the grant would cover cannot be told.
 */
const SESSION_GRANTS: Record<
  string,
  Record<"command" | "file-change", SessionGrant["covers"]> | undefined
> = {
  [CODEX]: { command: "every-command", "file-change": "every-file-change" },
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
  /** Whether the approval's prompt gave the action, so it is no reason. */
  readonly fromPrompt: boolean;
}

/** The command `gated` runs, as `approval` gives it, and whether its prompt gave it. */
const commandOf = (approval: ApprovalItem, gated: GatedItem & { type: "command_execution" }) =>
  gated.nativeItemRef?.driver === CLAUDE
    ? approval.prompt?.trim() === gated.input
      ? { text: approval.prompt, fromPrompt: true }
      : undefined
    : { text: gated.input, fromPrompt: false };

/**
 * Whether the card, showing `kept` of a file change's `given` diff, shows all
 * of it. Codex records an update's unified diff, whose trailing line breaks end
 * its last line and whose lines may end in CRLF, as a file with CRLF line
 * endings has them. For any other change it records the file's contents as
 * they are (Read at db51b67, `CodexAdapterV2` and the `tool_call_restricted_granular`
 * fixture), and Claude Code records its tool's output, so there a dropped
 * trailing line break is content the card leaves out: a file that ends in
 * none, one or two line breaks would look the same.
 */
const diffShown = (operation: string | undefined, given: string, kept: string) =>
  operation === "update"
    ? !UNSHOWABLE_BUT_CRLF.test(given)
    : kept === given && !UNSHOWABLE_BUT_CRLF.test(given);

/** What the held item says exactly, or `undefined` when it does not say what was asked. */
const exactOf = (
  kind: Approval["kind"],
  approval: ApprovalItem,
  gated: GatedItem,
): Shown | undefined => {
  if (kind === "command" && gated.type === "command_execution") {
    const given = commandOf(approval, gated);
    const command = verbatim(given?.text);
    return (
      given &&
      command && {
        action: command.text,
        detail: null,
        // A carriage return is part of the command wherever it is, even before a line feed.
        exact: command.whole && !UNSHOWABLE.test(given.text ?? ""),
        fromPrompt: given.fromPrompt,
      }
    );
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
      exact:
        diff !== undefined &&
        diff.whole &&
        paths.whole &&
        !UNSHOWABLE.test(paths.text) &&
        diffShown(changes[0]?.operation, gated.diffStr ?? "", diff.text),
      fromPrompt: false,
    };
  }
  return undefined;
};

/**
 * What "Allow for session" grants for an exact action of `kind`, or `null` when
 * the provider takes no such grant here or what it covers is not known. When
 * the approval lists its options, it takes one only if they hold
 * `acceptForSession`; when it lists none, the engine's own client offers
 * "Always allow this session", and Codex and Claude Code take it (Read at
 * db51b67, `ComposerPendingApprovalActions.tsx`).
 */
const sessionGrantOf = (kind: Approval["kind"], approval: ApprovalItem): SessionGrant | null => {
  if (kind !== "command" && kind !== "file-change") return null;
  const covers = SESSION_GRANTS[approval.nativeItemRef?.driver ?? ""]?.[kind];
  const offered =
    approval.options?.some((option) => option.decision === "acceptForSession") ?? true;
  return covers !== undefined && offered ? { covers } : null;
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
        fromPrompt: prompt !== undefined,
      };
  // The prompt, when the action came from elsewhere and the prompt says
  // something else, is the provider's reason for asking. A text that trims to
  // the action is the action again, not a reason.
  const action = shown.action.trim();
  const reasons = [
    trimmed(approval.reason),
    shown.fromPrompt ? undefined : trimmed(approval.prompt),
  ].filter((text): text is string => text !== undefined && text !== action);
  const reason = [...new Set(reasons)].join("\n\n").slice(0, MAX_REASON).trim();
  return {
    _tag: "approval",
    kind,
    action: shown.action,
    detail: shown.detail,
    exact: shown.exact,
    reason: reason === "" ? null : reason,
    sessionGrant: shown.exact ? sessionGrantOf(kind, approval) : null,
  };
}
