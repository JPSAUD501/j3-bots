// SPDX-License-Identifier: AGPL-3.0-or-later
import type { ConversationHandle, J3Client, Loaded, LoadedHandle } from "@j3-bots/client-runtime";
import { routineRunLines } from "@j3-bots/client-runtime/wording";
import type { BotId, Routine } from "@j3-bots/contracts";
import { createI18n } from "@j3-bots/i18n";
import { AppState } from "react-native";
import { appLink, appScheme } from "../links.ts";
import { stateFace } from "../platform/faceImages.ts";
import { shownLanguage, subscribePreferences } from "../preferences.ts";
import { presentationNow } from "../presentation.tsx";
import type { Session } from "../session.ts";
import {
  homeWidget,
  type HomeWidgetNative,
  type WidgetFaceImages,
  type WidgetTarget,
} from "./native.ts";
import {
  snapshotKey,
  unpairedSnapshot,
  type WidgetFace,
  type WidgetSnapshot,
  widgetFaces,
  widgetSnapshot,
  widgetWords,
} from "./snapshot.ts";

// What keeps the home-screen widgets up to date: while the app's JavaScript
// runs, whichever of its windows is open, it follows what the widgets show
// and writes them a new snapshot whenever that changes. It writes only from
// what it heard while connected; otherwise a widget keeps what it showed,
// and Android draws it again at its own refresh.

/** A face's side in the widget, in px: sharp on a large widget at three pixels per px. */
const FACE_SIZE = 192;

/** How long changes settle before the widgets are written, in ms. */
const SETTLE = 400;

/** A bot's faces as its widget draws them, now and at rest, each in both themes. */
const faceImages = (faces: ReadonlyArray<WidgetFace>): WidgetFaceImages =>
  Object.fromEntries(
    faces.map(({ botId, avatar, state }) => [
      botId,
      {
        "now-light": stateFace(avatar, botId, state, "light", FACE_SIZE),
        "now-dark": stateFace(avatar, botId, state, "dark", FACE_SIZE),
        "quiet-light": stateFace(avatar, botId, "idle", "light", FACE_SIZE),
        "quiet-dark": stateFace(avatar, botId, "idle", "dark", FACE_SIZE),
      },
    ]),
  );

const wordsNow = () => {
  const i18n = createI18n(shownLanguage());
  return { i18n, base: { language: i18n.locale, words: widgetWords(i18n) } };
};

/** What is held open for some bots, opened as each is asked for and let go as it no longer is. */
const makeHolds = <H extends { readonly release: () => void }>(
  open: (botId: BotId) => H,
  follow: (handle: H) => () => void,
) => {
  const held = new Map<BotId, { readonly handle: H; readonly stop: () => void }>();
  return {
    /** Holds exactly `botIds`. */
    keep: (botIds: ReadonlySet<BotId>): void => {
      for (const [botId, { handle, stop }] of held) {
        if (botIds.has(botId)) continue;
        stop();
        handle.release();
        held.delete(botId);
      }
      for (const botId of botIds) {
        if (held.has(botId)) continue;
        const handle = open(botId);
        held.set(botId, { handle, stop: follow(handle) });
      }
    },
    get: (botId: BotId): H | undefined => held.get(botId)?.handle,
    values: (): ReadonlyArray<H> => [...held.values()].map(({ handle }) => handle),
  };
};

/** Follows one client for the widgets, until `stop`. */
const followClient = (
  client: J3Client,
  widgets: HomeWidgetNative,
  scheme: string,
  feed: {
    readonly targets: () => ReadonlyArray<WidgetTarget>;
    readonly written: (key: string) => void;
    readonly isWritten: (key: string) => boolean;
  },
) => {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const schedule = () => {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(write, SETTLE);
  };
  const routines = makeHolds<LoadedHandle<ReadonlyArray<Routine>>>(
    (botId) => client.openRoutines(botId),
    (handle) =>
      handle.state.subscribe(() => {
        hold();
        schedule();
      }),
  );
  // A routine that reported back said it in a message of its bot's conversation.
  const conversations = makeHolds<ConversationHandle>(
    (botId) => client.openConversation({ _tag: "conversation", botId }),
    (handle) => handle.state.subscribe(schedule),
  );

  /** Holds what the widgets' routines need: their bots' routines, and the conversations they reported to. */
  function hold() {
    const targets = feed.targets();
    const routineBots = new Set<BotId>();
    const delivered = new Set<BotId>();
    for (const target of targets) {
      if (target.kind !== "routine") continue;
      routineBots.add(target.botId);
      const loaded = routines.get(target.botId)?.state.get();
      const routine =
        loaded?._tag === "ready"
          ? loaded.value.find((candidate) => candidate.id === target.routineId)
          : undefined;
      if (routine?.lastRun?.status === "delivered") delivered.add(target.botId);
    }
    routines.keep(routineBots);
    conversations.keep(delivered);
  }

  function snapshotNow(): WidgetSnapshot | null {
    const roster = client.roster.get();
    if (client.connection.get()._tag !== "connected") return null;
    if (roster._tag !== "ready" || roster.stale) return null;
    const results = new Map<string, string>();
    for (const handle of conversations.values()) {
      for (const item of handle.state.get().items) {
        if (item._tag === "message") results.set(item.id, item.text);
      }
    }
    const { i18n, base } = wordsNow();
    const ctx = presentationNow(client, i18n);
    const states = new Map<BotId, Loaded<ReadonlyArray<Routine>>>();
    for (const target of feed.targets()) {
      const state = routines.get(target.botId)?.state.get();
      if (state !== undefined) states.set(target.botId, state);
    }
    return widgetSnapshot(
      feed.targets(),
      {
        roster: roster.value,
        routines: states,
        results,
        runText: (run) => {
          const lines = routineRunLines(run, ctx);
          return lines.reason === null ? lines.status : `${lines.status}. ${lines.reason}`;
        },
        link: (link) => appLink(scheme, link),
        now: Date.now(),
      },
      base,
    );
  }

  function write() {
    timer = null;
    const snapshot = snapshotNow();
    if (snapshot === null) return;
    const key = snapshotKey(snapshot);
    if (feed.isWritten(key)) return;
    feed.written(key);
    const roster = client.roster.get();
    const faces = faceImages(
      widgetFaces(feed.targets(), roster._tag === "ready" ? roster.value : []),
    );
    widgets.write(snapshot, faces).catch(() => feed.written(""));
  }

  const stops = [client.roster.subscribe(schedule), client.connection.subscribe(schedule)];
  hold();
  schedule();
  return {
    /** The widgets' targets changed: hold what they need now, and write. */
    retarget: () => {
      hold();
      schedule();
    },
    /** Writes now, if there is something new to write. */
    flush: () => {
      if (timer !== null) clearTimeout(timer);
      write();
    },
    stop: () => {
      if (timer !== null) clearTimeout(timer);
      for (const stop of stops) stop();
      routines.keep(new Set());
      conversations.keep(new Set());
    },
  };
};

type Followed = ReturnType<typeof followClient>;

/** The feed's refresh, once it runs. */
let refresh: (() => Promise<void>) | null = null;

/**
 * Reads what the widgets show again, and writes them what the app knows of
 * it, as a widget's setup does once a choice is made. Resolves once written,
 * or when there is nothing to write yet: what is still loading is written as
 * it arrives.
 */
export const refreshWidgets = (): Promise<void> => refresh?.() ?? Promise.resolve();

/** Keeps the home-screen widgets up to date while the app runs. Android only. */
export const keepWidgetsFed = (session: Session): void => {
  const scheme = appScheme();
  if (homeWidget === null || scheme === null) return;
  const widgets = homeWidget;
  let targets: ReadonlyArray<WidgetTarget> = [];
  let written = "";
  const feed = {
    targets: () => targets,
    written: (key: string) => {
      written = key;
    },
    isWritten: (key: string) => key === written,
  };

  let followed: { readonly client: J3Client; readonly feed: Followed } | null = null;
  const current = (): J3Client | null => {
    const state = session.state.get();
    if (state._tag !== "open") return null;
    return state.client.connection.get()._tag === "unpaired" ? null : state.client;
  };
  const writeUnpaired = () => {
    const snapshot = unpairedSnapshot(wordsNow().base);
    const key = snapshotKey(snapshot);
    if (key === written) return;
    written = key;
    widgets.write(snapshot, {}).catch(() => {
      written = "";
    });
  };
  const follow = () => {
    const state = session.state.get();
    if (state._tag === "starting") return;
    const client = current();
    if (followed?.client === client) return;
    followed?.feed.stop();
    followed =
      client === null ? null : { client, feed: followClient(client, widgets, scheme, feed) };
    if (client === null && targets.length > 0) writeUnpaired();
  };
  const read = async () => {
    targets = await widgets.targets().catch(() => []);
    follow();
    if (followed === null) {
      if (targets.length > 0 && session.state.get()._tag !== "starting") writeUnpaired();
    } else {
      followed.feed.retarget();
    }
  };

  // The session's client, and whether it is still paired.
  let watched: (() => void) | null = null;
  const watch = () => {
    watched?.();
    const state = session.state.get();
    watched = state._tag === "open" ? state.client.connection.subscribe(follow) : null;
    follow();
  };
  session.state.subscribe(watch);
  watch();
  // A widget added or set up while the app was away.
  AppState.addEventListener("change", (state) => {
    if (state === "active") void read();
  });
  // A language chosen in Settings: the widgets say it in that one.
  subscribePreferences(() => {
    if (followed === null) {
      if (targets.length > 0) writeUnpaired();
    } else {
      followed.feed.retarget();
    }
  });
  void read();

  refresh = async () => {
    await read();
    followed?.feed.flush();
  };
};
