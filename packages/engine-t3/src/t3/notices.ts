// SPDX-License-Identifier: AGPL-3.0-or-later
import type { OrchestrationV2TurnItem } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type { EngineNotice } from "../events.ts";
import { detailsOf } from "./failureDetails.ts";
import { driverOf } from "./Provision.ts";

// The engine tells a thread of many situations in `system_notice` items, in
// its own words (decision 0083). The operator sees only those that ask
// something of them or explain what would otherwise confuse them, in
// J3 Bots' words (`EngineNotice`); the adapter logs every one.
//
// What T3 Code 0.1.13 records as a notice, and what becomes of each, by
// where it comes from (**Read** at `bc0f04d`). Shown:
// - Claude Code's Auto mode is not in effect for a turn that asked for it
//   (`auto-mode-unavailable:`, `ClaudeAdapterV2.ts` `announceAutoFallback`),
//   or its bypass for one that asked for Full access
//   (`bypass-policy-downgrade:`, the turn's start in `ClaudeAdapterV2.ts`):
//   the bot asks before acting, which the operator did not choose.
// Logged only:
// - Claude Code's usage limit (`usage-limit:`): the turn fails at the limit,
//   which the turn's own failure says, with its reset.
// - A steer Stop reached before the AI read it (`unread-steer:`, and
//   `Orchestrator.ts`): the steer's own state says it (`steer-dropped`).
// - An MCP server that needs a sign-in (Claude Code) or failed to start
//   (Codex): the only server J3 Bots gives a harness is its own `j3` bridge,
//   which needs none; a connector the bot cannot reach says so in its work.
// - Claude Code's own warnings, and hooks that stopped a turn (Claude Code's
//   blocking notices, Codex's stop reason in `RunExecutionService.ts`):
//   free text J3 Bots cannot put in plain words. A turn that ended without
//   its reply already has its own notice.
// - The engine restarting under a turn (`ProviderRuntimeRecoveryService.ts`):
//   the turn's end and J3 Bots' own redelivery say it.
// - Branch renames, native forks and imported sessions
//   (`ThreadLaunchService.ts`, `ProviderTurnStartService.ts`,
//   `AgentSessionImporter.ts`): J3 Bots uses none of them.
// - An ACP or Pi agent's notices: free text of the agent's own.
// Compaction and the work a session does after its turn are not notices,
// and are not shown either (decision 0083).

type Item = OrchestrationV2TurnItem;
export type SystemNotice = Extract<Item, { type: "system_notice" }>;

/** How much a notice matters to the server's log. */
type NoticeLevel = "info" | "warning" | "error";

export const isSystemNotice = (item: Item): item is SystemNotice => item.type === "system_notice";

/** A notice without a level predates levels, and is a warning (the engine's contract). */
const levelOf = (notice: SystemNotice): NoticeLevel => notice.level ?? "warning";

/** `text` trimmed, redacted, scrubbed and cut (`detailsOf`), or null when empty. */
const scrubbed = (text: string, redact: (text: string) => string): string | null => {
  const trimmed = text.trim();
  return trimmed === "" ? null : detailsOf(trimmed, redact);
};

/**
 * The notice's headline, for the log: its title, or its message when it has
 * none. The message is left out of the log beside a title: it can quote what
 * the operator wrote, as a steer Stop reached unread does, and the log keeps
 * identifiers, not message text.
 */
const headlineOf = (notice: SystemNotice, redact: (text: string) => string): string | null =>
  scrubbed(notice.title ?? "", redact) ?? scrubbed(notice.message, redact);

const CLAUDE = driverOf("claude-code");

/** The provider's own id for the notice, when the provider recorded it. */
const nativeIdOf = (notice: SystemNotice, driver: string): string | null =>
  notice.nativeItemRef?.driver === driver ? notice.nativeItemRef.nativeId : null;

/** The engine notice the operator sees for `notice`, if it is one they see. */
export const engineNoticeOf = (
  notice: SystemNotice,
  redact: (text: string) => string,
): EngineNotice | undefined => {
  const nativeId = nativeIdOf(notice, CLAUDE);
  if (nativeId === null) return undefined;
  const permissionMode = nativeId.startsWith("auto-mode-unavailable:")
    ? "auto"
    : nativeId.startsWith("bypass-policy-downgrade:")
      ? "full-access"
      : undefined;
  if (permissionMode === undefined) return undefined;
  const details = scrubbed(notice.message, redact);
  return {
    _tag: "asks-before-acting",
    permissionMode,
    ...(details === null ? {} : { details }),
  };
};

const LOG = {
  info: Effect.logInfo,
  warning: Effect.logWarning,
  error: Effect.logError,
} as const satisfies Record<NoticeLevel, (message: string) => Effect.Effect<void>>;

/**
 * The server's log line for a notice the engine recorded in session
 * `session`, at the notice's level, whether or not the operator sees it.
 */
export const logNotice = (
  notice: SystemNotice,
  session: string,
  redact: (text: string) => string,
): Effect.Effect<void> =>
  LOG[levelOf(notice)](`The engine noted: ${headlineOf(notice, redact) ?? "(nothing said)"}`).pipe(
    Effect.annotateLogs({
      session,
      turn: notice.runId ?? "none",
      provider: notice.nativeItemRef?.driver ?? "engine",
    }),
  );
