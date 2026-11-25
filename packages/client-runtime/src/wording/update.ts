// SPDX-License-Identifier: AGPL-3.0-or-later
import type {
  ReceivedUpdateRefused,
  ReceivedUpdateStatus,
  ReleaseVersion,
} from "@j3-bots/contracts";
import type { I18n, KeyWith } from "@j3-bots/i18n";
import type { ServerFailure } from "../update/prompt.ts";
import { isRunning, type ServerUpdateView, type UpdateResult } from "../update/ServerUpdate.ts";

// The server's updates in words, the same on the web, the desktop and the
// phone: what it runs, what it is offered and whether it can take it from
// here, how an update under way is going, and how the last one ended.

/**
 * How a line is drawn: `quiet` for a fact, `working` while something is
 * under way, `offer` when there is something to do, `blocked` when something
 * failed or keeps the operator from doing it here.
 */
export type UpdateTone = "quiet" | "working" | "offer" | "blocked";

export interface ServerUpdateLine {
  readonly text: string;
  readonly tone: UpdateTone;
  /** What happens next, or what to do; null when the line says it all. */
  readonly hint: string | null;
  /** A command to run on the server's machine instead. */
  readonly command: string | null;
  /** The release the operator can update the server to from here. */
  readonly offer: { readonly version: ReleaseVersion; readonly notesUrl: string } | null;
}

const line = (
  text: string,
  tone: UpdateTone,
  more: Partial<Omit<ServerUpdateLine, "text" | "tone">> = {},
): ServerUpdateLine => ({ text, tone, hint: null, command: null, offer: null, ...more });

/** Whole percent of a download, when its size is known. */
const percent = (received: number, total: number | null) =>
  total === null || total <= 0 ? null : Math.min(100, Math.floor((received * 100) / total));

const UNABLE = {
  "desktop-managed": "serverUpdate.unable.desktopManaged",
  "started-by-hand": "serverUpdate.unable.startedByHand",
  checkout: "serverUpdate.unable.checkout",
  unpacked: "serverUpdate.unable.unpacked",
  "no-systemd": "serverUpdate.unable.noSystemd",
  "no-linger": "serverUpdate.unable.noLinger",
  "rollback-unfinished": "serverUpdate.unable.rollbackUnfinished",
  unknown: "serverUpdate.unable.unknown",
} as const satisfies Record<
  Extract<ReceivedUpdateStatus["canUpdate"], { _tag: "unable" }>["reason"],
  KeyWith
>;

/** An update under way, in words: how far it has come. */
const runningLine = (status: ReceivedUpdateStatus, i18n: I18n): ServerUpdateLine => {
  const { t } = i18n;
  // The run's target outlives the restart; the offer may be newer by then.
  const version = status.run?.to ?? status.available?.version ?? null;
  const { state } = status;
  switch (state._tag) {
    case "downloading": {
      const done = percent(state.receivedBytes, state.totalBytes);
      return line(
        version === null
          ? t("serverUpdate.working")
          : done === null
            ? t("serverUpdate.downloadingNoTotal", { version })
            : t("serverUpdate.downloading", { version, percent: done }),
        "working",
      );
    }
    case "verifying":
      return line(t("serverUpdate.verifying"), "working");
    case "installing":
      return line(
        version === null ? t("serverUpdate.working") : t("serverUpdate.installing", { version }),
        "working",
      );
    case "restarting":
      return line(restartingText(version, i18n), "working");
    default:
      return line(t("serverUpdate.working"), "working");
  }
};

const restartingText = (version: ReleaseVersion | null, { t }: I18n) =>
  version === null
    ? t("serverUpdate.restartingNoVersion")
    : t("serverUpdate.restarting", { version });

/** What the server is offered, and whether it can take it from here, when no update is under way. */
const restingLine = (status: ReceivedUpdateStatus, i18n: I18n): ServerUpdateLine => {
  const { t } = i18n;
  const { available, canUpdate } = status;
  if (available !== null) {
    if (canUpdate._tag === "unable") {
      return line(t("serverUpdate.available", { version: available.version }), "blocked", {
        hint: t(UNABLE[canUpdate.reason]),
        command: canUpdate.command,
      });
    }
    return line(t("serverUpdate.available", { version: available.version }), "offer", {
      hint: t("serverUpdate.available.hint", { current: status.current.version }),
      offer: { version: available.version, notesUrl: available.notesUrl },
    });
  }
  if (status.refused !== null) {
    return line(t("serverUpdate.refusedRelease", { version: status.refused.version }), "blocked");
  }
  if (status.lastCheck?.failure != null) return line(t("serverUpdate.checkFailed"), "quiet");
  if (status.waitingForStable) {
    return line(t("serverUpdate.waitingForStable", { version: status.current.version }), "quiet");
  }
  return line(t("update.upToDate"), "quiet");
};

/**
 * The server's updates in one line, or null before the status is read. It
 * does not say how the last update ended: `updateResultLine` does, once.
 */
export function serverUpdateLine(view: ServerUpdateView, i18n: I18n): ServerUpdateLine | null {
  const { t } = i18n;
  switch (view._tag) {
    case "unread":
      return null;
    case "unsupported":
      return line(t("serverUpdate.unsupported"), "quiet", { command: "j3-bots update" });
    case "unreachable":
      return line(t("serverUpdate.unreachable"), "quiet");
    case "restarting":
      return line(restartingText(view.to, i18n), "working");
    case "lost":
      return line(t("serverUpdate.lost"), "blocked", { command: "j3-bots doctor" });
    case "status":
      if (view.status.state._tag === "checking") return line(t("update.checking"), "working");
      return isRunning(view.status.state)
        ? runningLine(view.status, i18n)
        : restingLine(view.status, i18n);
  }
}

/**
 * The line for a server older than this client, on the screen that says so.
 * It never says the server is up to date. A server that cannot update from
 * here says how to update it on its machine. One with nothing newer on offer
 * says there is no release yet only once `checked`, after a check of its
 * release feed this client asked for has ended: until then the server may
 * not have looked since the release came out.
 */
export function serverBehindLine(
  view: ServerUpdateView,
  checked: boolean,
  i18n: I18n,
): ServerUpdateLine | null {
  if (view._tag !== "status") return serverUpdateLine(view, i18n);
  const { status } = view;
  if (status.available !== null || status.state._tag === "checking" || isRunning(status.state)) {
    return serverUpdateLine(view, i18n);
  }
  const { t } = i18n;
  if (status.canUpdate._tag === "unable") {
    return line(t(UNABLE[status.canUpdate.reason]), "blocked", {
      command: status.canUpdate.command,
    });
  }
  if (!checked) return line(t("update.checking"), "working");
  if (status.refused !== null || status.lastCheck?.failure != null) {
    return restingLine(status, i18n);
  }
  return line(t("gate.incompatible.serverBehindNoRelease"), "quiet");
}

const FAILURES = {
  "health-check": "serverUpdate.failure.healthCheck",
  download: "serverUpdate.failure.download",
  verification: "serverUpdate.failure.verification",
  engine: "serverUpdate.failure.engine",
  disk: "serverUpdate.failure.disk",
  interrupted: "serverUpdate.failure.interrupted",
  // What failed is in the result's `detail`, in English, from the server's log.
  other: "serverUpdate.failure.unknown",
  unknown: "serverUpdate.failure.unknown",
} as const satisfies Record<NonNullable<UpdateResult["reason"]>, KeyWith>;

/** How an update ended: on the new version, back on the old one with why, or stuck. */
export function updateResultLine(result: UpdateResult, i18n: I18n): ServerUpdateLine {
  const { t } = i18n;
  const reason = result.reason === null ? null : t(FAILURES[result.reason]);
  switch (result.outcome) {
    case "done":
      return line(t("serverUpdate.result.done", { version: result.to }), "quiet");
    case "rolled-back":
      return line(
        t("serverUpdate.result.rolledBack", { from: result.from, to: result.to }),
        "blocked",
        {
          hint: reason,
        },
      );
    case "failed":
      return line(
        t("serverUpdate.result.failed", { from: result.from, to: result.to }),
        "blocked",
        {
          hint: reason,
          command: "j3-bots update --rollback",
        },
      );
    case "unknown":
      return line(t("serverUpdate.result.unknown", { version: result.to }), "quiet");
  }
}

const REFUSALS = {
  "not-available": "serverUpdate.refusal.notAvailable",
  busy: "serverUpdate.refusal.busy",
  "work-running": "serverUpdate.refusal.workRunning",
  unable: "serverUpdate.refusal.unable",
  unknown: "serverUpdate.refusal.unknown",
} as const satisfies Record<ReceivedUpdateRefused["reason"], KeyWith>;

/** Why the server did not start an update, for a refusal the client does not answer itself. */
export const startRefusalText = (reason: ReceivedUpdateRefused["reason"], { t }: I18n): string =>
  t(REFUSALS[reason]);

/** Why the update prompt's server part did not go through, and what to run when there is something. */
export function serverFailureLine(failure: ServerFailure, i18n: I18n): ServerUpdateLine {
  switch (failure._tag) {
    case "refused":
      return line(startRefusalText(failure.reason, i18n), "blocked");
    case "unreachable":
      return line(i18n.t("serverUpdate.notReached"), "blocked");
    case "ended":
      return updateResultLine(failure.result, i18n);
    case "lost":
      return line(i18n.t("serverUpdate.lost"), "blocked", { command: "j3-bots doctor" });
  }
}
