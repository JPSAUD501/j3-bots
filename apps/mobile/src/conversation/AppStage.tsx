// SPDX-License-Identifier: AGPL-3.0-or-later
import { Cell, type J3Client, type Readable } from "@j3-bots/client-runtime";
import {
  botRepliesAfter,
  type ConnectorAppAsk,
  type ConnectorAppDisplay,
  type ConnectorAppDisplayMode,
  type ConnectorAppDownload,
  type ConnectorAppHost,
  type ConnectorAppPlace,
  connectorAppDocument,
  connectorAppHost,
  connectorAppShell,
  connectorAppStartHeight,
  readThrough,
  rowOrder,
  type TimelineItem,
} from "@j3-bots/client-runtime/presentation";
import { useJ3Client } from "@j3-bots/client-runtime/react";
import type {
  ConnectorAppRef,
  ConnectorAppViewId,
  EntryOrder,
  MessageEntry,
} from "@j3-bots/contracts";
import {
  createContext,
  use,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { BackHandler, Linking } from "react-native";
import { shareAppFiles } from "../platform/openFile.ts";
import {
  closeFrame,
  deliverToFrame,
  frameKey,
  listenToFrame,
  NativeAppFrame,
} from "./appFrames.ts";

// Where a conversation on Android shows its connectors' apps (decision 0093):
// in the bot's reply, over the conversation (`fullscreen`), or pinned at its
// top while it scrolls (`pip`), one at a time. An app's frame runs while its
// place in the reply is drawn, or while it is shown full screen or pinned,
// and a while after, so scrolling past it and back does not start it again;
// it moves between those places without loading again. The same as the web
// does (`apps/web/src/components/AppStage.tsx`), with the frames' lives here
// rather than in the reply, which the list stops drawing as it scrolls away.

/** How long an app keeps running after nothing draws it, in ms. */
const KEPT_OUT_OF_VIEW = 20_000;

/** What an app asked that waits on the operator, in the client's own line under the frame. */
export type AppAsk = { readonly id: number } & (
  | { readonly _tag: "call"; readonly tool: string; readonly done: (ask: ConnectorAppAsk) => void }
  | { readonly _tag: "message"; readonly text: string; readonly done: (send: boolean) => void }
  | { readonly _tag: "link"; readonly url: URL; readonly done: (open: boolean) => void }
  | {
      readonly _tag: "download";
      readonly names: ReadonlyArray<string>;
      readonly done: (save: boolean) => void;
    }
);

export interface LiveAppState {
  /** The page its frame loads, once the app is opened; null while it opens or once it failed. */
  readonly page: string | null;
  readonly failed: boolean;
  /** The height it asked for in the reply, within bounds; the last it had while it opens again. */
  readonly height: number;
  /** The height it asked for pinned, laid out at the pinned width; null until it did. */
  readonly pinnedHeight: number | null;
  /** The modes it can be shown in here, once it said. */
  readonly modes: ReadonlyArray<ConnectorAppDisplayMode>;
  readonly asks: ReadonlyArray<AppAsk>;
}

/** An app that runs, or opens to run, in the conversation. */
export interface LiveApp {
  readonly app: ConnectorAppRef;
  /** Its frame's (`NativeAppFrame`). */
  readonly key: string;
  readonly state: Readable<LiveAppState>;
  /** Where a view draws it in `mode`, which the app is told while it is shown so. */
  readonly placed: (
    mode: ConnectorAppDisplayMode,
    size: { readonly width: number; readonly height: number },
  ) => void;
}

/** An app shown other than in the reply. */
export interface StagedApp {
  readonly app: ConnectorAppRef;
  readonly mode: Exclude<ConnectorAppDisplayMode, "inline">;
}

export interface AppStageState {
  /** The modes the conversation can show an app in. */
  readonly modes: ReadonlyArray<ConnectorAppDisplayMode>;
  readonly staged: StagedApp | null;
  /** Shows the app in `mode`, and returns the mode it is shown in now. */
  readonly show: (
    viewId: ConnectorAppViewId,
    mode: ConnectorAppDisplayMode,
  ) => ConnectorAppDisplayMode;
  /** What the bots said since an app went full screen, which shows over it. */
  readonly replies: ReadonlyArray<MessageEntry>;
  /** The apps that run, by their view. */
  readonly lives: Readable<ReadonlyMap<ConnectorAppViewId, LiveApp>>;
  /** Keeps `app` running until the function it returns is called, and a while after. */
  readonly hold: (app: ConnectorAppRef) => () => void;
}

/** What every app of the conversation is told of where it is drawn, but its display. */
export type PlaceBase = Omit<ConnectorAppPlace, "display">;

type Size = { readonly width: number; readonly height: number };

interface Entry {
  readonly live: LiveApp;
  readonly state: Cell<LiveAppState>;
  holds: number;
  idle: ReturnType<typeof setTimeout> | null;
  host: ConnectorAppHost | null;
  mode: ConnectorAppDisplayMode;
  readonly sizes: Record<ConnectorAppDisplayMode, Size>;
  ended: boolean;
}

const displayOf = (entry: Entry): ConnectorAppDisplay => {
  const { width, height } = entry.sizes[entry.mode];
  return entry.mode === "fullscreen"
    ? { mode: "fullscreen", width, height }
    : { mode: entry.mode, width };
};

const isFile = (
  file: ConnectorAppDownload,
): file is Extract<ConnectorAppDownload, { readonly _tag: "file" }> => file._tag === "file";

interface Surroundings {
  readonly client: J3Client;
  readonly server: URL | null;
  readonly base: PlaceBase;
  readonly show: AppStageState["show"];
}

/**
 * The apps of one conversation that run: each from the first view that
 * holds it to `KEPT_OUT_OF_VIEW` after the last one lets go, when it is told
 * it goes and its frame closes once it answered.
 */
function liveApps(first: Surroundings, unstage: (viewId: ConnectorAppViewId) => void) {
  let surroundings = first;
  const now = () => surroundings;
  const lives = new Cell<ReadonlyMap<ConnectorAppViewId, LiveApp>>(new Map());
  const entries = new Map<ConnectorAppViewId, Entry>();

  const publish = () =>
    lives.set(new Map([...entries].map(([viewId, entry]) => [viewId, entry.live])));

  const tell = (entry: Entry) =>
    entry.host?.placeChanged({ ...now().base, display: displayOf(entry) });

  const end = (entry: Entry, reason: string) => {
    if (entry.ended) return;
    entry.ended = true;
    if (entry.idle !== null) clearTimeout(entry.idle);
    entries.delete(entry.live.app.viewId);
    publish();
    const { key } = entry.live;
    const host = entry.host;
    entry.host = null;
    if (host === null) {
      closeFrame(key);
      return;
    }
    void host.teardown(reason).then(() => closeFrame(key));
  };

  const fail = (entry: Entry) => {
    entry.host = null;
    closeFrame(entry.live.key);
    entry.state.update((state) => ({ ...state, page: null, failed: true, asks: [] }));
    unstage(entry.live.app.viewId);
  };

  const start = (entry: Entry) => {
    const { client, server } = now();
    const { viewId } = entry.live.app;
    if (NativeAppFrame === null || server === null) {
      entry.state.update((state) => ({ ...state, failed: true }));
      return;
    }
    void client.connectors.app.open(viewId).then((opened) => {
      if (entry.ended) return;
      const document = opened._tag === "done" ? connectorAppDocument(opened.value, server) : null;
      if (opened._tag !== "done" || document === null) {
        entry.state.update((state) => ({ ...state, failed: true }));
        return;
      }
      const view = opened.value;
      let next = 0;
      const asked = <A,>(make: (id: number, done: (answer: A) => void) => AppAsk): Promise<A> =>
        new Promise<A>((resolve) => {
          const ask = make((next += 1), (answer) => {
            entry.state.update((state) => ({
              ...state,
              asks: state.asks.filter((other) => other !== ask),
            }));
            resolve(answer);
          });
          entry.state.update((state) => ({ ...state, asks: [...state.asks, ask] }));
        });
      const answered = <A,>(
        result: { readonly _tag: "done"; readonly value: A } | { readonly _tag: "failed" },
      ) => (result._tag === "done" ? result.value : null);
      const host = connectorAppHost({
        view,
        place: { ...now().base, display: displayOf(entry) },
        send: (message) => deliverToFrame(entry.live.key, message),
        callTool: (name, args, allowed) =>
          client.connectors.app.callTool(viewId, name, args, allowed).then(answered),
        readResource: (uri) => client.connectors.app.readResource(viewId, uri).then(answered),
        setContext: (context) => client.connectors.app.setContext(viewId, context).then(answered),
        confirmCall: (tool) =>
          asked<ConnectorAppAsk>((id, done) => ({ _tag: "call", id, tool, done })),
        // Sent only when the operator presses Send, as their own message to the bot.
        proposeMessage: (text) =>
          asked<boolean>((id, done) => ({ _tag: "message", id, text, done })).then((send) =>
            send
              ? client
                  .send({ target: { _tag: "conversation", botId: view.botId }, text })
                  .then((result) => result._tag === "done")
              : false,
          ),
        openLink: (url) =>
          asked<boolean>((id, done) => ({ _tag: "link", id, url, done })).then((open) => {
            if (open) void Linking.openURL(url.href).catch(() => undefined);
            return open;
          }),
        // Handed to the share sheet, or opened in the browser, only when the operator presses Save.
        download: (files) =>
          asked<boolean>((id, done) => ({
            _tag: "download",
            id,
            // A file by the name it is saved under; an address as itself, which is where it goes.
            names: files.map((file) => (file._tag === "file" ? file.name : file.url.href)),
            done,
          })).then((save) => {
            if (!save) return false;
            void shareAppFiles(files.filter(isFile));
            for (const file of files) {
              if (file._tag === "link") void Linking.openURL(file.url.href).catch(() => undefined);
            }
            return true;
          }),
        setDisplayMode: (mode) => now().show(viewId, mode),
        onModes: (modes) => entry.state.update((state) => ({ ...state, modes })),
        // Full screen, it fills the room it has: what it reports there says nothing of the reply.
        onHeight: (height, mode) =>
          entry.state.update((state) =>
            mode === "inline"
              ? { ...state, height }
              : mode === "pip"
                ? { ...state, pinnedHeight: height }
                : state,
          ),
      });
      entry.host = host;
      listenToFrame(entry.live.key, {
        message: (data) => host.receive(data),
        failed: () => fail(entry),
      });
      entry.state.update((state) => ({ ...state, page: connectorAppShell(document) }));
    });
  };

  const make = (app: ConnectorAppRef): Entry => {
    const state = new Cell<LiveAppState>({
      page: null,
      failed: false,
      height: connectorAppStartHeight(app.viewId),
      pinnedHeight: null,
      modes: [],
      asks: [],
    });
    const blank = { width: 0, height: 0 };
    const entry: Entry = {
      live: {
        app,
        key: frameKey(app.viewId),
        state,
        placed: (mode, size) => {
          const known = entry.sizes[mode];
          if (known.width === size.width && known.height === size.height) return;
          entry.sizes[mode] = size;
          if (mode === entry.mode) tell(entry);
        },
      },
      state,
      holds: 0,
      idle: null,
      host: null,
      mode: "inline",
      sizes: { inline: blank, fullscreen: blank, pip: blank },
      ended: false,
    };
    return entry;
  };

  return {
    lives,
    hold: (app: ConnectorAppRef) => {
      let entry = entries.get(app.viewId);
      if (entry === undefined) {
        entry = make(app);
        entries.set(app.viewId, entry);
        publish();
        start(entry);
      }
      const held = entry;
      held.holds += 1;
      if (held.idle !== null) clearTimeout(held.idle);
      held.idle = null;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        held.holds -= 1;
        if (held.holds > 0 || held.ended) return;
        held.idle = setTimeout(() => end(held, "The app scrolled out of view."), KEPT_OUT_OF_VIEW);
      };
    },
    /** Tells every app where it is shown now: `staged`'s app as staged, every other one in the reply. */
    stage: (staged: StagedApp | null) => {
      for (const entry of entries.values()) {
        const mode = staged?.app.viewId === entry.live.app.viewId ? staged.mode : "inline";
        if (entry.mode === mode) continue;
        entry.mode = mode;
        // Shown in a mode for the first time, the app is told once its frame is laid out there.
        if (entry.sizes[mode].width > 0) tell(entry);
      }
    },
    /** What the apps reach of the conversation as it is now: a new theme or language reaches every app. */
    surround: (next: Surroundings) => {
      const moved = next.base !== surroundings.base;
      surroundings = next;
      if (moved) for (const entry of entries.values()) tell(entry);
    },
    endAll: () => {
      for (const entry of entries.values()) end(entry, "The conversation closed.");
    },
  };
}

const INLINE_ONLY: ReadonlyArray<ConnectorAppDisplayMode> = ["inline"];
const EVERY_MODE: ReadonlyArray<ConnectorAppDisplayMode> = ["inline", "fullscreen", "pip"];

/** The modes a conversation on this phone shows an app in: in the reply only, without the module. */
export const STAGE_MODES = NativeAppFrame === null ? INLINE_ONLY : EVERY_MODE;

const noLives = new Cell<ReadonlyMap<ConnectorAppViewId, LiveApp>>(new Map());

const AppStageContext = createContext<AppStageState>({
  modes: INLINE_ONLY,
  staged: null,
  show: () => "inline",
  replies: [],
  lives: noLives,
  hold: () => () => undefined,
});

export const useAppStage = (): AppStageState => use(AppStageContext);
export const AppStage = AppStageContext;

/**
 * The stage of one conversation's apps, which the conversation mounts once:
 * an app shown full screen in one is not in the next. Back takes a
 * full-screen app back to the reply.
 */
export function useAppStageState({
  rows,
  server,
  base,
}: {
  readonly rows: ReadonlyArray<TimelineItem>;
  /** The server this client speaks to, which no app may reach; null while there is none. */
  readonly server: URL | null;
  readonly base: PlaceBase;
}): AppStageState {
  const client = useJ3Client();
  const [staged, setStaged] = useState<(StagedApp & { readonly since: EntryOrder | null }) | null>(
    null,
  );

  // What is in the conversation as an app goes full screen: only what comes after shows over it.
  const latest = useRef<EntryOrder | null>(null);
  useLayoutEffect(() => {
    latest.current = readThrough(rows.map(rowOrder));
  }, [rows]);

  // What the apps reach of the conversation is set again below as it changes, and once `show` is made.
  const [apps] = useState(() =>
    liveApps({ client, server, base, show: () => "inline" }, (viewId) =>
      setStaged((current) => (current?.app.viewId === viewId ? null : current)),
    ),
  );

  const show = useCallback(
    (viewId: ConnectorAppViewId, mode: ConnectorAppDisplayMode): ConnectorAppDisplayMode => {
      if (mode === "inline") {
        setStaged((current) => (current?.app.viewId === viewId ? null : current));
        return "inline";
      }
      const live = apps.lives.get().get(viewId);
      if (!STAGE_MODES.includes(mode) || live === undefined) return "inline";
      setStaged({ app: live.app, mode, since: latest.current });
      return mode;
    },
    [apps],
  );

  useLayoutEffect(() => {
    apps.surround({ client, server, base, show });
  }, [apps, client, server, base, show]);
  useEffect(() => apps.stage(staged), [apps, staged]);
  useEffect(() => apps.endAll, [apps]);

  const fullscreen = staged?.mode === "fullscreen";
  useEffect(() => {
    if (!fullscreen) return;
    const subscription = BackHandler.addEventListener("hardwareBackPress", () => {
      setStaged(null);
      return true;
    });
    return () => subscription.remove();
  }, [fullscreen]);

  return useMemo<AppStageState>(
    () => ({
      modes: STAGE_MODES,
      staged: staged === null ? null : { app: staged.app, mode: staged.mode },
      show,
      replies: staged?.mode === "fullscreen" ? botRepliesAfter(rows, staged.since) : [],
      lives: apps.lives,
      hold: apps.hold,
    }),
    [staged, show, rows, apps],
  );
}
