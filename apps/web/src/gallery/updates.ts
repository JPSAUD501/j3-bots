// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Updating the server and the desktop app, in every state the gallery shows:
 * what a server says through its update routes, and the app's own update.
 * Development only.
 */
import type { ServerUpdateView, UpdateResult } from "@j3-bots/client-runtime";
import { DeviceId, type ReceivedUpdateStatus } from "@j3-bots/contracts";
import { releasePage, type UpdatePhase, type UpdateStatus } from "@j3-bots/desktop-bridge";
import * as DateTime from "effect/DateTime";
import type { DesktopUpdate, RemoteServerUpdate } from "../shell/data";
import { SAMPLE_NOW } from "./sample";

const nothing = () => {};
const minutesAgo = (minutes: number) => DateTime.subtract(SAMPLE_NOW, { minutes });

const NEXT = "0.4.0";
const CURRENT = "0.3.1";
const NIGHTLY = "0.4.1-nightly.20261120.3";

/** A server on 0.3.1, on the stable channel, that found nothing newer five minutes ago. */
const upToDate: ReceivedUpdateStatus = {
  api: 1,
  current: { version: CURRENT, channel: "stable" },
  channel: "stable",
  available: null,
  waitingForStable: false,
  refused: null,
  lastCheck: { at: minutesAgo(5), failure: null, nextAt: DateTime.add(SAMPLE_NOW, { hours: 6 }) },
  canUpdate: { _tag: "able" },
  state: { _tag: "idle" },
  run: null,
  lastResult: null,
};

const release = {
  version: NEXT,
  channel: "stable",
  publishedAt: minutesAgo(90),
  notesUrl: releasePage(NEXT),
  verified: true,
} as const;

const available: ReceivedUpdateStatus = { ...upToDate, available: release };

/** The update from 0.3.1 to 0.4.0 this device asked for three minutes ago. */
const run = {
  from: CURRENT,
  to: NEXT,
  by: DeviceId.make("device-laptop"),
  startedAt: minutesAgo(3),
};

const result = (
  outcome: "done" | "rolled-back" | "failed",
  reason: "health-check" | "disk" | null,
  detail: string | null,
): UpdateResult => ({
  outcome,
  from: CURRENT,
  to: NEXT,
  at: minutesAgo(2),
  by: DeviceId.make("device-laptop"),
  reason,
  detail,
});

const restartingStatus: ReceivedUpdateStatus = {
  ...available,
  state: { _tag: "restarting" },
  run,
};

/** Each state a server's update can be in, as the server reports it. */
export const serverStatuses = {
  upToDate,
  available,
  checking: { ...upToDate, state: { _tag: "checking" } },
  checkFailed: {
    ...upToDate,
    lastCheck: { at: minutesAgo(1), failure: "unreachable", nextAt: SAMPLE_NOW },
  },
  downloading: {
    ...available,
    state: { _tag: "downloading", receivedBytes: 31_000_000, totalBytes: 74_000_000 },
    run,
  },
  verifying: { ...available, state: { _tag: "verifying" }, run },
  installing: { ...available, state: { _tag: "installing" }, run },
  restarting: restartingStatus,
  // Once a run ends the server is idle again, and its last result says how it ended.
  done: {
    ...upToDate,
    current: { version: NEXT, channel: "stable" },
    lastResult: result("done", null, null),
  },
  rolledBack: {
    ...available,
    lastResult: result(
      "rolled-back",
      "health-check",
      "J3 Bots 0.4.0 did not become ready within 5 minutes: the engine stayed starting.",
    ),
  },
  failed: {
    ...available,
    canUpdate: {
      _tag: "unable",
      reason: "rollback-unfinished",
      command: "j3-bots update --rollback",
    },
    lastResult: result("failed", "disk", "No space left on the disk to restore the snapshot."),
  },
  startedByHand: {
    ...available,
    canUpdate: { _tag: "unable", reason: "started-by-hand", command: "j3-bots update" },
  },
  desktopManaged: {
    ...available,
    canUpdate: { _tag: "unable", reason: "desktop-managed", command: null },
  },
  nightly: {
    ...upToDate,
    current: { version: NIGHTLY, channel: "nightly" },
    channel: "nightly",
    available: {
      ...release,
      version: "0.4.1-nightly.20261121.1",
      channel: "nightly",
      notesUrl: releasePage("0.4.1-nightly.20261121.1"),
    },
  },
  waitingForStable: {
    ...upToDate,
    current: { version: NIGHTLY, channel: "nightly" },
    waitingForStable: true,
  },
  refused: {
    ...upToDate,
    refused: { version: NEXT, reason: "signature-invalid" },
  },
} satisfies Record<string, ReceivedUpdateStatus>;

/**
 * Updating the server from the gallery, its view `view`: nothing it asks
 * reaches a server. A check ends at once and changes nothing, unless
 * `checkEnds` is false, when it never ends.
 */
export const serverUpdate = (
  view: ServerUpdateView,
  ended: UpdateResult | null = null,
  checkEnds = true,
): RemoteServerUpdate => ({
  view,
  ended,
  dismissEnded: nothing,
  refresh: nothing,
  check: () => (checkEnds ? Promise.resolve() : new Promise<void>(nothing)),
  setChannel: nothing,
  start: () => Promise.resolve({ _tag: "refused", reason: "busy", runningBots: null }),
});

/** A server that says `status`. */
export const said = (status: ReceivedUpdateStatus): ServerUpdateView => ({
  _tag: "status",
  status,
});

/** The views of a server that does not say anything the gallery shows as a status. */
export const serverViews = {
  unread: { _tag: "unread" },
  unsupported: { _tag: "unsupported" },
  restarting: { _tag: "restarting", to: NEXT, last: restartingStatus },
  lost: { _tag: "lost", to: NEXT, last: restartingStatus },
} satisfies Record<string, ServerUpdateView>;

/** How the update to 0.4.0 this device followed ended, as it saw it end. */
export const endedDone: UpdateResult = result("done", null, null);

/**
 * The desktop app on 0.3.1 (or `current`), its update in `phase`: updating by
 * itself unless `automatic` says otherwise (`null` for a build that does not
 * install updates, as one in the `released` phase), and open as usual unless
 * `launch` says it is updating as it starts.
 */
export const appUpdate = (
  phase: UpdatePhase,
  options: {
    readonly current?: string;
    readonly channel?: UpdateStatus["channel"];
    readonly automatic?: boolean | null;
    readonly launch?: UpdateStatus["launch"];
  } = {},
): DesktopUpdate => ({
  status: {
    current: options.current ?? CURRENT,
    channel: options.channel ?? "stable",
    phase,
    automatic:
      options.automatic === undefined
        ? phase._tag === "released"
          ? null
          : true
        : options.automatic,
    launch: options.launch ?? "over",
  },
  check: nothing,
  restart: nothing,
  setChannel: nothing,
  setAutomatic: nothing,
});

/** Each state of the app's own update the gallery shows. */
export const appPhases = {
  upToDate: { _tag: "idle", checked: true },
  downloading: { _tag: "downloading", version: NEXT, percent: 64 },
  verifying: { _tag: "verifying", version: NEXT },
  ready: { _tag: "downloaded", version: NEXT, restart: "offered" },
  verifyFailed: { _tag: "failed", stage: "verify" },
  released: { _tag: "released", version: NEXT },
  installing: { _tag: "installing", version: NEXT },
} satisfies Record<string, UpdatePhase>;

export const SAMPLE_NIGHTLY = NIGHTLY;
export const SAMPLE_NEXT = NEXT;
