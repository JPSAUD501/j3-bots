// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  type AppRelease,
  type ClientSide,
  type J3Client,
  makeUpdatePrompt,
  type Readable,
  serverRelease,
  snoozeStore,
  type UpdatePrompt,
  type UpdatePromptEntry,
  type UpdatePromptInput,
  updatePromptEntry,
  updatePromptShown,
} from "@j3-bots/client-runtime";
import { useJ3Client, useReadable, useServerUpdate } from "@j3-bots/client-runtime/react";
import { serverUpdateLine } from "@j3-bots/client-runtime/wording";
import type { RosterItem } from "@j3-bots/contracts";
import { releasePage, type UpdateStatus } from "@j3-bots/desktop-bridge";
import { useEffect, useState } from "react";
import { useI18n } from "../app/context";
import { useUpdateLine } from "../components/AppUpdate";
import type { UpdatePromptView } from "../components/UpdatePrompt";
import { desktopUpdateStatus, installDesktopUpdate, useDesktopUpdate } from "./appUpdate";
import { desktop } from "./desktop";

// The update prompt on the web and in the desktop app: what this client
// brings to it, and one runner per client, which outlives the screens it is
// shown over (the shell, and the one for a server this app no longer speaks
// with), so an update under way carries on across them.

/**
 * A newer version of the desktop app the operator can take now: downloaded,
 * checked and waiting for its restart, or out for a build that does not
 * install it itself. A browser has none: its page comes with the server.
 */
const appRelease = (status: UpdateStatus | null): AppRelease | null => {
  if (status === null) return null;
  const { phase } = status;
  const page = (version: string) => ({
    version,
    notesUrl: releasePage(version),
    highlights: [],
  });
  switch (phase._tag) {
    case "downloaded":
      return { ...page(phase.version), how: "install" };
    case "released":
      return { ...page(phase.version), how: "download" };
    default:
      return null;
  }
};

/** Bots with a turn under way, which a restart of the server they run on stops. */
const atWork = (roster: ReadonlyArray<RosterItem>): number =>
  roster.filter(
    (item) =>
      item._tag === "bot" &&
      (item.bot.state._tag === "thinking" ||
        item.bot.state._tag === "working" ||
        (item.bot.state._tag === "waiting" && item.bot.state.since !== null)),
  ).length;

/**
 * What this client brings to the prompt: a browser reloads after the
 * server; the desktop app installs itself where its build does, and in
 * local mode its restart stops the bots it runs.
 */
export const clientSideOf = (
  status: UpdateStatus | null,
  roster: ReadonlyArray<RosterItem> | null,
): ClientSide => {
  if (desktop === null) return { follow: "reload", app: null, workItStops: 0 };
  const installs = status !== null && status.automatic !== null;
  return {
    follow: installs ? "install" : "none",
    app: appRelease(status),
    workItStops: desktop.mode === "local" && roster !== null ? atWork(roster) : 0,
  };
};

const rosterOf = (j3: J3Client): ReadonlyArray<RosterItem> | null => {
  const synced = j3.roster.get();
  return synced._tag === "ready" ? synced.value : null;
};

const SNOOZE_KEY = "j3:updatePromptSnooze";

const prompts = new WeakMap<J3Client, UpdatePrompt>();

/** The update prompt's runner for `j3`, made on first use. */
export const updatePromptOf = (j3: J3Client): UpdatePrompt => {
  const made = prompts.get(j3);
  if (made !== undefined) return made;
  const side: Readable<ClientSide> = {
    get: () => clientSideOf(desktopUpdateStatus.get(), rosterOf(j3)),
    subscribe: desktopUpdateStatus.subscribe,
  };
  const prompt = makeUpdatePrompt({
    server: j3.serverUpdate,
    client: {
      side,
      update: (how) => {
        if (how === "install") return installDesktopUpdate();
        // The page comes with the server: loading it again loads the new one.
        window.location.reload();
        return new Promise<never>(() => {});
      },
      openDownload: (url) => {
        window.open(url, "_blank", "noopener");
      },
    },
    snooze: snoozeStore({
      get: () => window.localStorage.getItem(SNOOZE_KEY),
      set: (value) =>
        value === null
          ? window.localStorage.removeItem(SNOOZE_KEY)
          : window.localStorage.setItem(SNOOZE_KEY, value),
    }),
    now: Date.now,
  });
  prompts.set(j3, prompt);
  return prompt;
};

/** When the next "Later" runs out, so the prompt is looked at again then. */
const useNow = (until: number | null): number => {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (until === null || until <= now) return;
    // Timers take at most about 24.8 days; a longer wait looks again then.
    const wait = Math.min(until - now, 2 ** 31 - 1);
    const timer = window.setTimeout(() => setNow(Date.now()), wait);
    return () => window.clearTimeout(timer);
  }, [until, now]);
  return now;
};

/** The update prompt as this page shows it, and its quiet entry point. */
export interface UpdatePromptHandle {
  readonly view: UpdatePromptView;
  readonly entry: UpdatePromptEntry | null;
  readonly reopen: () => void;
}

/**
 * The update prompt for the page: what the dialog shows and whether it is
 * in front, with `blocked` when another screen already asks in front.
 */
export function useUpdatePrompt(blocked: boolean): UpdatePromptHandle {
  const j3 = useJ3Client();
  const i18n = useI18n();
  const prompt = updatePromptOf(j3);
  const state = useReadable(prompt.state);
  const serverView = useServerUpdate();
  const roster = useReadable(j3.roster);
  const pairing = useReadable(j3.pairing);
  const update = useDesktopUpdate();
  const status = update?.status ?? null;
  const side = clientSideOf(status, roster._tag === "ready" ? roster.value : null);
  const appLine = useUpdateLine(update);
  const now = useNow(state.snooze?.until ?? null);
  const input: UpdatePromptInput = {
    paired: pairing !== null,
    blocked,
    server: serverRelease(serverView),
    app: side.app,
    now,
  };
  return {
    view: {
      open: updatePromptShown(state, input),
      run: state.run,
      server: input.server,
      app: side.app,
      follow: side.follow,
      local: desktop?.mode === "local",
      serverLine: serverUpdateLine(serverView, i18n),
      appLine,
      updateNow: prompt.updateNow,
      later: prompt.later,
      stopWork: prompt.stopWork,
      retry: prompt.retry,
      hide: prompt.hide,
    },
    entry: updatePromptEntry(state, input),
    reopen: prompt.reopen,
  };
}
