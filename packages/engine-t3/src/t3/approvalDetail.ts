// SPDX-License-Identifier: AGPL-3.0-or-later
import { APPROVAL_TEXT_LENGTH, type ApprovalChange, type SessionGrant } from "@j3-bots/contracts";
import type { OrchestrationV2RuntimeRequest, OrchestrationV2TurnItem } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import type { EngineRequest } from "../events.ts";
import { heldCallLabel } from "./toolNames.ts";

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
// A file change's diff does not reach the adapter with the item. The engine
// strips `diffStr`, `oldStr` and `newStr` from every `file_change` it sends on
// a thread's stream, live or in a snapshot, unless the change failed (Read at
// bc0f04d, `WireProjection.ts`, `projectTurnItemForWire`, used by `ws.ts` for
// replays and snapshots and by `EventSink.ts` for live events). So an approval
// whose held file change came without its diff is first a summary, and the
// adapter fetches the item whole with `orchestration.getTurnItem`, which keeps
// the diff (`projectTurnItemForDetail`, through `ThreadManagementService`). The
// fetched item counts only for the version of the item it was fetched for.
//
// Read at bc0f04d: Claude Code's command item is not the command as it runs.
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
export type FileChangeItem = Extract<Item, { type: "file_change" }>;
type RuntimeRequest = OrchestrationV2RuntimeRequest;
export type Approval = Extract<EngineRequest, { _tag: "approval" }>;

/** The engine's drivers for Codex and Claude Code, as its items name them. Read at bc0f04d. */
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
 * space or a line break though it is neither, and every bidi control (the
 * marks, embeddings, overrides and isolates), which reorder the text around
 * them on screen or draw as nothing.
 */
const UNSHOWABLE = /[\r\p{Bidi_Control}]/u;

/** As `UNSHOWABLE`, except a carriage return that, with the line feed after it, ends a line. */
const UNSHOWABLE_BUT_CRLF = /\r(?!\n)|\p{Bidi_Control}/u;

/**
 * What the engine appends to a text it cut: at 32 KiB when it stores a file
 * change's diff, and at 256 KiB when `getTurnItem` returns it (Read at bc0f04d,
 * `WireProjection.ts`, `truncateDetail`, called by `boundFileChangeForStorage`
 * from `ProviderEventIngestor.ts` and by `projectTurnItemForDetail`). A diff
 * that ends with it is not the whole change. A diff that happens to end with
 * these words is taken for a cut one, which only costs it its exactness.
 */
const TRUNCATED = "\n… output truncated for transport";

const trimmed = (text: string | null | undefined) => {
  const kept = text?.trim() ?? "";
  return kept === "" ? undefined : kept;
};

/**
 * What `prompt` says besides `action`: the lines after it when it opens with
 * it, as Codex's prompt for a command does, followed by the directory it runs
 * in and the host it reaches (**Read** at bc0f04d, `CodexAdapterV2.ts`
 * `codexCommandApprovalPrompt`); otherwise the whole prompt.
 */
const afterAction = (prompt: string | null | undefined, action: string) => {
  const text = trimmed(prompt);
  if (text === undefined || action === "" || !text.startsWith(action)) return text;
  const rest = text.slice(action.length);
  return /^[^\S\n]*\r?\n/.test(rest) ? trimmed(rest) : text;
};

/**
 * What a grant for the session allows from then on, by the provider that takes
 * it and the kind of action shown exactly. Read at bc0f04d:
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

/** A `j3` tool call an approval holds back: a connector's, or one that manages MCP servers or skills. */
interface ConnectorCall {
  /** The engine's item of the call. */
  readonly itemId: string;
  readonly label: string;
  readonly input: unknown;
}

/**
 * The `j3` call `approval` holds back, by the same native id, with its item,
 * the name its card gives it and its input as the engine recorded them: a
 * connector's call, or one of J3 Bots' own that changes MCP servers or
 * skills, which are not pre-approved (decision 0049). Claude Code's prompt
 * for an MCP tool is the tool's `command` argument when it has one, so the
 * card of `add_mcp_server` for a command server, or of a connector tool,
 * could show that alone, as a shell command; the card names the tool instead. **Read** at `bc0f04d`: the
 * approval and the call share the tool use's id as a strong native id
 * (`ClaudeAdapterV2.ts`, `buildApprovalRequestArtifacts` and
 * `buildToolCallArtifacts`), and the prompt prefers `command` (`canUseTool`).
 */
export const heldConnectorCall = (
  approval: ApprovalItem,
  request: RuntimeRequest | undefined,
  items: Iterable<Item>,
): ConnectorCall | undefined => {
  const ref = approval.nativeItemRef;
  if (ref === null || ref.nativeId === null || ref.strength !== "strong") return undefined;
  const asked = request?.nativeRequestRef;
  if (asked?.driver !== ref.driver || asked.nativeId !== ref.nativeId) return undefined;
  for (const item of items) {
    if (
      item.type === "dynamic_tool" &&
      item.runId === approval.runId &&
      item.nativeItemRef?.strength === "strong" &&
      item.nativeItemRef.driver === ref.driver &&
      item.nativeItemRef.nativeId === ref.nativeId
    ) {
      const label = item.toolName === null ? undefined : heldCallLabel(item.toolName);
      return label === undefined ? undefined : { itemId: item.id, label, input: item.input };
    }
  }
  return undefined;
};

/**
 * A held `j3` call's card: the tool, then its input as the engine recorded
 * it, which is what the connector, or J3 Bots, will be sent.
 */
const connectorApproval = (call: ConnectorCall): Approval => {
  const action = `${call.label} ${JSON.stringify(call.input ?? {})}`;
  const shown = action.slice(0, APPROVAL_TEXT_LENGTH);
  return {
    _tag: "approval",
    kind: "tool",
    action: shown,
    detail: null,
    exact: shown === action && !UNSHOWABLE.test(action),
    reason: null,
    sessionGrant: null,
  };
};

/** Held file changes fetched whole from the engine, by item id. */
export type FetchedChanges = ReadonlyMap<string, FileChangeItem>;

/** Whether `fetched` is `held` as the engine recorded it at the same update. */
export const sameVersion = (held: FileChangeItem, fetched: FileChangeItem) =>
  fetched.id === held.id &&
  DateTime.toEpochMillis(fetched.updatedAt) === DateTime.toEpochMillis(held.updatedAt);

/** The held item, or, for a file change that came without its diff, the one fetched for it. */
const wholeItem = (gated: GatedItem, fetched: FetchedChanges): GatedItem => {
  if (gated.type !== "file_change" || gated.diffStr !== undefined) return gated;
  const whole = fetched.get(gated.id);
  return whole !== undefined && sameVersion(gated, whole) ? whole : gated;
};

/**
 * The file change `approval` holds back, when it came without its diff and the
 * card could show it whole with one: the item to fetch for the approval's card,
 * at the version the approval holds.
 */
export function fileChangeWithoutDiff(
  approval: ApprovalItem,
  request: RuntimeRequest | undefined,
  items: Iterable<Item>,
): FileChangeItem | undefined {
  if (KINDS[approval.requestKind] !== "file-change") return undefined;
  const gated = gatedItem(approval, request, items);
  if (gated?.type !== "file_change" || gated.diffStr !== undefined) return undefined;
  // The card shows a diff for one file only, so a change of several is never
  // exact. Codex records one patch over every file of such a change (Read at
  // bc0f04d, `CodexAdapterV2.ts`, `codexMultiFilePatch`), which the card does
  // not show.
  return (gated.changes?.length ?? 0) > 1 ? undefined : gated;
}

interface Shown {
  readonly action: string;
  readonly detail: ApprovalChange | null;
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
 * they are (Read at bc0f04d, `CodexAdapterV2` and the `tool_call_restricted_granular`
 * fixture), and Claude Code records its tool's output, so there a dropped
 * trailing line break is content the card leaves out: a file that ends in
 * none, one or two line breaks would look the same.
 */
const diffShown = (operation: ApprovalChange["operation"], given: string, kept: string) =>
  operation === "update"
    ? !UNSHOWABLE_BUT_CRLF.test(given)
    : kept === given && !UNSHOWABLE_BUT_CRLF.test(given);

const OPERATIONS: ReadonlySet<string> = new Set(["add", "delete", "update"]);
const isOperation = (operation: string): operation is NonNullable<ApprovalChange["operation"]> =>
  OPERATIONS.has(operation);

/**
 * A change's operation as the card names it, or `null` when the engine names
 * none or one the card does not know. Codex names `add`, `delete` and
 * `update`, a move being an update (Read at bc0f04d, `CodexAdapterV2.ts`,
 * `buildFileChangeArtifacts`).
 */
const operationOf = (operation: string | undefined): ApprovalChange["operation"] =>
  operation !== undefined && isOperation(operation) ? operation : null;

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
    // The card shows a diff for one file only: with several changes, a diff
    // the engine recorded may cover only part of them, and Codex's patch over
    // all of them is not shown.
    const given = gated.diffStr ?? "";
    const diff = changes.length <= 1 ? verbatim(given) : undefined;
    const operation = operationOf(changes[0]?.operation);
    return {
      action: paths.text,
      detail: diff === undefined ? null : { operation, text: diff.text },
      exact:
        diff !== undefined &&
        diff.whole &&
        !given.endsWith(TRUNCATED) &&
        paths.whole &&
        !UNSHOWABLE.test(paths.text) &&
        diffShown(operation, given, diff.text),
      fromPrompt: false,
    };
  }
  return undefined;
};

/**
 * What the engine's accept for the session ("Don’t ask again" on the card) grants for an exact action of `kind`, or `null` when
 * the provider takes no such grant here or what it covers is not known. When
 * the approval lists its options, it takes one only if they hold
 * `acceptForSession`; when it lists none, the engine's own client offers
 * "Always allow this session", and Codex and Claude Code take it (Read at
 * bc0f04d, `ComposerPendingApprovalActions.tsx`).
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
 * it holds back, and `fetched` the file changes fetched whole for approvals.
 */
export function approvalOf(
  approval: ApprovalItem,
  request: RuntimeRequest | undefined,
  items: Iterable<Item>,
  fetched: FetchedChanges,
): Approval {
  // Read twice: once for a connector call, once for a command or file change.
  const thread = [...items];
  const connector = heldConnectorCall(approval, request, thread);
  if (connector !== undefined) return connectorApproval(connector);
  const kind = KINDS[approval.requestKind];
  const gated = gatedItem(approval, request, thread);
  const exact =
    gated === undefined ? undefined : exactOf(kind, approval, wholeItem(gated, fetched));
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
  // the action is the action again, not a reason, and a prompt that opens with
  // the action adds only the lines after it.
  const action = shown.action.trim();
  const reasons = [
    trimmed(approval.reason),
    shown.fromPrompt ? undefined : afterAction(approval.prompt, action),
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
