// SPDX-License-Identifier: AGPL-3.0-or-later
import type { ReceivedUpdateRefused } from "@j3-bots/contracts";
import { isRunning, type ServerUpdateView, type UpdateResult } from "./ServerUpdate.ts";

// The update prompt, as a pure model: when the big "Update now" dialog opens
// in front of the app, and what pressing it does, step by step. The server
// goes first and this client follows it, as decision 0051 sets: the server
// updates through its own update (snapshot, health check, rollback), the
// client waits until it answers on the new version, then updates itself, or
// reloads where it comes with the server. A server update that does not end
// on the new version stops the sequence there. With the server current and
// only this app behind, the app's part runs alone. A runner feeds it what the
// server and the app report and the operator's choices, and does only what a
// step returns.

/** A newer release one side can be updated to, and what it brings. */
export interface Release {
  readonly version: string;
  /** Its page, with its notes. */
  readonly notesUrl: string;
  /** Its highlights, from its notes; empty when it has none. */
  readonly highlights: ReadonlyArray<string>;
}

/**
 * A newer version of this app: one it installs itself (`install`), or one
 * the operator downloads by hand, as for a build that cannot install it
 * (`download`).
 */
export interface AppRelease extends Release {
  readonly how: "install" | "download";
}

/**
 * How this client follows an update of its server: it installs a newer
 * version of itself when there is one (the desktop app and the Android app
 * where they update themselves), it reloads because it comes with the server
 * (a browser's page), or it does nothing, being updated another way.
 */
export type ClientFollow = "install" | "reload" | "none";

/** What this client brings to the prompt, as its platform reports it now. */
export interface ClientSide {
  readonly follow: ClientFollow;
  /** A newer version of this app ready for the operator; null when there is none. */
  readonly app: AppRelease | null;
  /**
   * How many bots have work running that this client's own restart stops:
   * those of the server it runs, in the desktop app's local mode; 0 elsewhere.
   */
  readonly workItStops: number;
}

/** What "Update now" set out to do, kept for the steps after the first. */
export interface Plan {
  /** The server's release, or null when the server is current. */
  readonly server: Release | null;
  /** The app's release known when it started, if any. */
  readonly app: AppRelease | null;
  /** How this client follows the server, or updates alone: null when it does nothing. */
  readonly client: "install" | "reload" | null;
}

/** Why the server's part did not end on the new version. */
export type ServerFailure =
  /** The server would not start it. */
  | { readonly _tag: "refused"; readonly reason: ReceivedUpdateRefused["reason"] }
  /** The request to start it did not reach the server. */
  | { readonly _tag: "unreachable" }
  /** It ran and ended elsewhere: rolled back, or failed with its rollback. */
  | { readonly _tag: "ended"; readonly result: UpdateResult }
  /** It started and the server has not answered since, for as long as an update may take. */
  | { readonly _tag: "lost" };

/**
 * Where the sequence stands:
 *
 * - `idle`: nothing started; the prompt opens when something is on offer;
 * - `work-running`: bots have work running that the update would stop,
 *   on the server (`server`) or on this computer (`client`): the operator
 *   stops it or comes back later;
 * - `server`: the server updates, from the request until it answers on the
 *   new version;
 * - `client`: this client updates, or reloads;
 * - `server-failed`, `client-failed`: that part did not go through, and
 *   nothing after it ran;
 * - `done`: the server runs the new version, and this client had nothing to
 *   install.
 *
 * `hidden`: the operator put the dialog aside while the part runs; it comes
 * back when the sequence needs them.
 */
export type Run =
  | { readonly _tag: "idle" }
  | {
      readonly _tag: "work-running";
      readonly side: "server" | "client";
      readonly runningBots: number;
      readonly plan: Plan;
    }
  | { readonly _tag: "server"; readonly plan: Plan; readonly hidden: boolean }
  | { readonly _tag: "client"; readonly plan: Plan; readonly hidden: boolean }
  | { readonly _tag: "server-failed"; readonly plan: Plan; readonly failure: ServerFailure }
  | { readonly _tag: "client-failed"; readonly plan: Plan }
  | { readonly _tag: "done"; readonly plan: Plan };

/**
 * "Later": the prompt stays closed until `until` for exactly these versions.
 * A newer release on either side opens it again sooner.
 */
export interface Snooze {
  readonly until: number;
  readonly server: string | null;
  readonly app: string | null;
}

/** How long "Later" keeps the prompt closed. */
export const SNOOZE_MS = 24 * 60 * 60 * 1000;

export interface Prompt {
  readonly run: Run;
  readonly snooze: Snooze | null;
}

export const initial = (snooze: Snooze | null): Prompt => ({ run: { _tag: "idle" }, snooze });

export type PromptEvent =
  /** The operator pressed "Update now" at `now`, with what is on offer at that moment. */
  | {
      readonly _tag: "update-now";
      readonly server: Release | null;
      readonly client: ClientSide;
      readonly now: number;
    }
  /** The operator agreed that the update stops the bots' running work. */
  | { readonly _tag: "stop-work" }
  /** The server refused to start. */
  | {
      readonly _tag: "server-refused";
      readonly reason: ReceivedUpdateRefused["reason"];
      readonly runningBots: number | null;
    }
  /** The request to start did not reach the server. */
  | { readonly _tag: "server-unreachable" }
  /** The server's update ended, and the server answered with how. */
  | { readonly _tag: "server-ended"; readonly result: UpdateResult }
  /** The server's update stopped answering for as long as one may take. */
  | { readonly _tag: "server-lost" }
  /** This client found nothing newer to install. */
  | { readonly _tag: "client-current" }
  /** This client's update did not go through. */
  | { readonly _tag: "client-failed" }
  /** The operator pressed "Try again" at `now`, with what is on offer at that moment. */
  | {
      readonly _tag: "retry";
      readonly server: Release | null;
      readonly client: ClientSide;
      readonly now: number;
    }
  /** The operator pressed "Later" at `now`, with the versions on offer then. */
  | {
      readonly _tag: "later";
      readonly now: number;
      readonly server: string | null;
      readonly app: string | null;
    }
  /** The operator put the dialog aside while a part runs, or closed it once it ended. */
  | { readonly _tag: "hide" }
  /** The operator opened it again from its quiet entry point. */
  | { readonly _tag: "reopen" };

export type PromptAction =
  /** Ask the server to update to `version`. */
  | { readonly _tag: "start-server"; readonly version: string; readonly stopWork: boolean }
  /** Update this client: install what is newer, or reload. */
  | { readonly _tag: "update-client"; readonly how: "install" | "reload" }
  /** Open the page the app's new version is downloaded from. */
  | { readonly _tag: "open-download"; readonly url: string };

export interface Step {
  readonly next: Prompt;
  readonly action: PromptAction | null;
}

const IDLE: Run = { _tag: "idle" };

const stay = (prompt: Prompt): Step => ({ next: prompt, action: null });

/** This client's part, once the server's is over or not needed. */
const clientPart = (prompt: Prompt, plan: Plan, stopWork: boolean, workItStops: number): Step => {
  if (plan.client === null) {
    return stay({ ...prompt, run: plan.server === null ? IDLE : { _tag: "done", plan } });
  }
  if (plan.client === "install" && workItStops > 0 && !stopWork) {
    return stay({
      ...prompt,
      run: { _tag: "work-running", side: "client", runningBots: workItStops, plan },
    });
  }
  return {
    next: { ...prompt, run: { _tag: "client", plan, hidden: false } },
    action: { _tag: "update-client", how: plan.client },
  };
};

/** What "Update now" and "Try again" start: the server first, when it has a release. */
const begin = (
  prompt: Prompt,
  event: { readonly server: Release | null; readonly client: ClientSide; readonly now: number },
): Step => {
  const { server, client } = event;
  // A build that cannot install itself, with a current server: the
  // operator downloads the new version, and the prompt rests as after "Later".
  if (server === null && client.app?.how === "download") {
    return {
      next: {
        run: IDLE,
        snooze: { until: event.now + SNOOZE_MS, server: null, app: client.app.version },
      },
      action: { _tag: "open-download", url: client.app.notesUrl },
    };
  }
  const follows = server === null ? client.app !== null : client.follow !== "none";
  const plan: Plan = {
    server,
    app: client.app,
    client: !follows ? null : server === null || client.follow === "install" ? "install" : "reload",
  };
  if (server === null) return clientPart(prompt, plan, false, client.workItStops);
  return {
    next: { ...prompt, run: { _tag: "server", plan, hidden: false } },
    action: { _tag: "start-server", version: server.version, stopWork: false },
  };
};

export const step = (prompt: Prompt, event: PromptEvent): Step => {
  const { run } = prompt;
  switch (event._tag) {
    case "update-now":
      return run._tag === "idle" || run._tag === "done"
        ? begin(prompt, event)
        : stay(prompt);
    case "retry":
      switch (run._tag) {
        case "server-failed":
          return begin(prompt, event);
        case "client-failed":
          return clientPart(prompt, run.plan, true, 0);
        default:
          return stay(prompt);
      }
    case "stop-work":
      if (run._tag !== "work-running") return stay(prompt);
      if (run.side === "client") return clientPart(prompt, run.plan, true, 0);
      return run.plan.server === null
        ? stay(prompt)
        : {
            next: { ...prompt, run: { _tag: "server", plan: run.plan, hidden: false } },
            action: { _tag: "start-server", version: run.plan.server.version, stopWork: true },
          };
    case "server-refused":
      if (run._tag !== "server") return stay(prompt);
      return stay({
        ...prompt,
        run:
          event.reason === "work-running"
            ? {
                _tag: "work-running",
                side: "server",
                runningBots: event.runningBots ?? 1,
                plan: run.plan,
              }
            : {
                _tag: "server-failed",
                plan: run.plan,
                failure: { _tag: "refused", reason: event.reason },
              },
      });
    case "server-unreachable":
    case "server-lost":
      return run._tag === "server"
        ? stay({
            ...prompt,
            run: {
              _tag: "server-failed",
              plan: run.plan,
              failure: { _tag: event._tag === "server-lost" ? "lost" : "unreachable" },
            },
          })
        : stay(prompt);
    case "server-ended": {
      if (run._tag !== "server" || run.plan.server === null) return stay(prompt);
      const { result } = event;
      // Only an update that ended on the version asked for lets the client follow.
      if (result.outcome !== "done" || result.to !== run.plan.server.version) {
        return stay({
          ...prompt,
          run: { _tag: "server-failed", plan: run.plan, failure: { _tag: "ended", result } },
        });
      }
      // The server this client runs is never the one updated here, so its restart stops nothing.
      return clientPart(prompt, run.plan, false, 0);
    }
    case "client-current":
      return run._tag === "client"
        ? stay({ ...prompt, run: run.plan.server === null ? IDLE : { _tag: "done", plan: run.plan } })
        : stay(prompt);
    case "client-failed":
      return run._tag === "client"
        ? stay({ ...prompt, run: { _tag: "client-failed", plan: run.plan } })
        : stay(prompt);
    case "later":
      switch (run._tag) {
        case "idle":
        case "work-running":
        case "server-failed":
        case "client-failed":
          return stay({
            run: IDLE,
            snooze: { until: event.now + SNOOZE_MS, server: event.server, app: event.app },
          });
        default:
          return stay(prompt);
      }
    case "hide":
      switch (run._tag) {
        case "server":
        case "client":
          return stay({ ...prompt, run: { ...run, hidden: true } });
        case "done":
          return stay({ ...prompt, run: IDLE });
        default:
          return stay(prompt);
      }
    case "reopen":
      switch (run._tag) {
        case "idle":
          return stay({ ...prompt, snooze: null });
        case "server":
        case "client":
          return stay({ ...prompt, run: { ...run, hidden: false } });
        default:
          return stay(prompt);
      }
  }
};

/** What the prompt is shown with: who looks, and what is on offer now. */
export interface PromptInput {
  /**
   * Whether this client holds the operator's credential for its server: a
   * paired device. Nobody else is shown anything.
   */
  readonly paired: boolean;
  /**
   * Whether another screen already asks in front, as the one for a server
   * this client cannot talk to: the prompt then shows only a sequence under
   * way, and opens nothing of its own.
   */
  readonly blocked: boolean;
  /** The server's release this client can start now (`serverRelease`). */
  readonly server: Release | null;
  /** A newer version of this app ready for the operator. */
  readonly app: AppRelease | null;
  readonly now: number;
}

/** Whether "Later" still keeps the prompt closed for what is on offer. */
export const snoozed = (snooze: Snooze | null, input: PromptInput): boolean =>
  snooze !== null &&
  input.now < snooze.until &&
  (input.server === null || input.server.version === snooze.server) &&
  (input.app === null || input.app.version === snooze.app);

/** Whether the dialog is in front now. */
export const shown = (prompt: Prompt, input: PromptInput): boolean => {
  if (!input.paired) return false;
  const { run } = prompt;
  switch (run._tag) {
    case "idle":
      return (
        !input.blocked &&
        (input.server !== null || input.app !== null) &&
        !snoozed(prompt.snooze, input)
      );
    case "server":
    case "client":
      return !run.hidden;
    case "work-running":
    case "server-failed":
    case "client-failed":
    case "done":
      return true;
  }
};

/**
 * What the quiet entry point says while the dialog is not in front: a
 * release waits (after "Later"), or an update runs behind it. Null when
 * there is nothing to come back to.
 */
export type Entry =
  | { readonly _tag: "offer"; readonly version: string }
  | { readonly _tag: "running" };

export const entry = (prompt: Prompt, input: PromptInput): Entry | null => {
  if (!input.paired || input.blocked || shown(prompt, input)) return null;
  const { run } = prompt;
  if (run._tag === "server" || run._tag === "client") return { _tag: "running" };
  if (run._tag !== "idle") return null;
  const version = input.server?.version ?? input.app?.version ?? null;
  return version === null ? null : { _tag: "offer", version };
};

/**
 * The release on the server that this client can start now: a verified,
 * newer one, on a server that can update itself from a client and runs no
 * update. A server that cannot (as the one the desktop app runs, which
 * updates with the app) offers nothing here: its Settings say why.
 */
export const serverRelease = (view: ServerUpdateView): Release | null => {
  if (view._tag !== "status") return null;
  const { available, canUpdate, state } = view.status;
  if (available === null || canUpdate._tag !== "able" || isRunning(state)) return null;
  return {
    version: available.version,
    notesUrl: available.notesUrl,
    highlights: available.highlights,
  };
};
