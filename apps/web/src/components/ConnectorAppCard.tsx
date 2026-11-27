// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  type BotId,
  CONNECTOR_APP_FRAME_PATH,
  type ConnectorAppAnswer,
  type ConnectorAppContext,
  type ConnectorAppContextOutcome,
  type ConnectorAppRef,
  type ConnectorAppView,
  type ConnectorAppViewId,
} from "@j3-bots/contracts";
import {
  CONNECTOR_APP_FRAME_SANDBOX,
  type ConnectorAppAsk,
  type ConnectorAppDisplay,
  type ConnectorAppDisplayMode,
  type ConnectorAppDownload,
  type ConnectorAppHost,
  type ConnectorAppPlace,
  connectorAppDocument,
  connectorAppHost,
  connectorAppStartHeight,
  fromOwnFrame,
  MAX_CONNECTOR_APP_PIP_HEIGHT,
} from "@j3-bots/client-runtime/presentation";
import { springs } from "@j3-bots/design-tokens";
import type * as Schema from "effect/Schema";
import { Maximize2Icon, XIcon } from "lucide-react";
import {
  type CSSProperties,
  useContext,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useBots, useI18n } from "../app/context";
import { useClock } from "../app/clock";
import { cn } from "../lib/cn";
import { play } from "../lib/motion";
import { usePreferences } from "../preferences/preferences";
import { type AppStageState, useAppStage } from "./AppStage";
import { ConnectorTile } from "./connectors/parts";
import { MessageText } from "./MessageText";
import { VisualTheme } from "./VisualCard";
import { Button } from "./ui/button";

// A connector's app: the interface a connector's server gave the tool a bot
// called, part of the bot's reply where the call happened (decision 0093),
// in a frame that shares nothing with the client. It can go full screen over
// the conversation or pin to its top, in the same frame, which is never
// loaded again for it. docs/architecture/security.md, "Connector apps", says
// how the frame is shut and what the app can still reach;
// docs/architecture/clients.md says how a client draws one.

/** What a timeline does for the apps its bots' replies show. */
export interface ConnectorAppAccess {
  /** The J3 Bots server the client speaks to, which no app may reach. */
  readonly server: URL;
  /** Where the client runs, as an app is told: a browser, or the desktop app. */
  readonly platform: "web" | "desktop";
  /** The app, ready to draw; null when it is gone or the server could not be reached. */
  readonly open: (viewId: ConnectorAppViewId) => Promise<ConnectorAppView | null>;
  readonly callTool: (
    viewId: ConnectorAppViewId,
    name: string,
    args: Schema.JsonObject,
    allowed: boolean,
  ) => Promise<ConnectorAppAnswer | null>;
  readonly readResource: (
    viewId: ConnectorAppViewId,
    uri: string,
  ) => Promise<ConnectorAppAnswer | null>;
  readonly setContext: (
    viewId: ConnectorAppViewId,
    context: ConnectorAppContext,
  ) => Promise<ConnectorAppContextOutcome | null>;
  /** Sends `text` to the bot as the operator's own message; true once it went. */
  readonly sendMessage: (botId: BotId, text: string) => Promise<boolean>;
  /** Opens `url` in the operator's browser, outside the client. */
  readonly openLink: (url: URL) => void;
  /** Saves the files an app offered, through the browser's download. */
  readonly save: (files: ReadonlyArray<Extract<ConnectorAppDownload, { _tag: "file" }>>) => void;
}

/** What the app asked that waits on the operator, in the client's own line under the frame. */
type Ask = { readonly id: number } & (
  | { readonly _tag: "call"; readonly tool: string; readonly done: (ask: ConnectorAppAsk) => void }
  | { readonly _tag: "message"; readonly text: string; readonly done: (send: boolean) => void }
  | { readonly _tag: "link"; readonly url: URL; readonly done: (open: boolean) => void }
  | {
      readonly _tag: "download";
      readonly names: ReadonlyArray<string>;
      readonly done: (save: boolean) => void;
    }
);

type Loaded =
  | { readonly _tag: "loading" }
  | { readonly _tag: "ready"; readonly view: ConnectorAppView; readonly document: string }
  | { readonly _tag: "failed" };

/** How far out of the conversation's view an app's frame starts running, and stops, in CSS pixels. */
const NEAR = "1200px 0px";
const FAR = "3600px 0px";

/** Whether an app is near enough the conversation's view to run: starts near it, stops far from it. */
function useNearView(element: HTMLElement | null, scroller: HTMLElement | null, kept: boolean) {
  const [near, setNear] = useState(scroller === null);
  useEffect(() => {
    if (element === null || scroller === null) return;
    const comes = new IntersectionObserver(
      (records) => {
        if (records.some((record) => record.isIntersecting)) setNear(true);
      },
      { root: scroller, rootMargin: NEAR },
    );
    const goes = new IntersectionObserver(
      (records) => {
        if (records.every((record) => !record.isIntersecting)) setNear(false);
      },
      { root: scroller, rootMargin: FAR },
    );
    comes.observe(element);
    goes.observe(element);
    return () => {
      comes.disconnect();
      goes.disconnect();
    };
  }, [element, scroller]);
  // A full-screen or pinned app is in view wherever its place in the reply is.
  return near || kept || scroller === null;
}

/**
 * One app in the bot's reply: a light header with its connector and its tool,
 * and its frame, which follows the app's height within bounds. The frame
 * runs only near the conversation's view and keeps its last height while it
 * does not. Shown full screen or pinned, its place in the reply keeps its
 * height and says where it is.
 */
export function ConnectorAppBlock({
  app,
  access,
}: {
  readonly app: ConnectorAppRef;
  readonly access: ConnectorAppAccess;
}) {
  const { t } = useI18n();
  const stage = useAppStage();
  const mode: ConnectorAppDisplayMode =
    stage.staged?.viewId === app.viewId ? stage.staged.mode : "inline";
  const [slot, setSlot] = useState<HTMLDivElement | null>(null);
  const wanted = useNearView(slot, stage.scroller, mode !== "inline");
  const [loaded, setLoaded] = useState<Loaded>({ _tag: "loading" });
  const [height, setHeight] = useState(() => connectorAppStartHeight(app.viewId));
  // The modes the app can be shown in here, once it said: the header offers full screen from them.
  const [modes, setModes] = useState<ReadonlyArray<ConnectorAppDisplayMode>>([]);
  // The frame, while there is one: one going away stays until the app answered its teardown,
  // and one wanted again after is a new frame.
  const [live, setLive] = useState<{
    readonly generation: number;
    readonly leaving: boolean;
  } | null>(null);
  const generations = useRef(0);

  // Opened once, when first near the view: drawn again from what was opened.
  useEffect(() => {
    if (!wanted || loaded._tag !== "loading") return;
    let current = true;
    void access.open(app.viewId).then((view) => {
      if (!current) return;
      const document = view === null ? null : connectorAppDocument(view, access.server);
      setLoaded(
        view === null || document === null ? { _tag: "failed" } : { _tag: "ready", view, document },
      );
    });
    return () => {
      current = false;
    };
  }, [access, app.viewId, wanted, loaded._tag]);

  useEffect(() => {
    if (loaded._tag !== "ready") return;
    if (wanted && live === null) {
      generations.current += 1;
      setLive({ generation: generations.current, leaving: false });
    } else if (!wanted && live !== null && !live.leaving) {
      setLive({ ...live, leaving: true });
    }
  }, [wanted, loaded._tag, live]);

  const { show } = stage;

  const canExpand = modes.includes("fullscreen") && mode !== "fullscreen";
  const placeholder =
    mode === "fullscreen" ? t("connectorApp.shownFull") : t("connectorApp.shownPinned");

  return (
    <figure className="my-1 flex w-(--layout-card-width) max-w-full flex-col overflow-hidden rounded-bubble border border-border bg-surface">
      <AppHeader
        app={app}
        {...(canExpand ? { onExpand: () => void show(app.viewId, "fullscreen") } : {})}
      />
      <div
        ref={setSlot}
        className="relative"
        // Drawn in the reply, the frame and its questions give the slot its height; otherwise it
        // keeps the app's last height, so the reply does not move.
        style={
          loaded._tag === "failed" || (live !== null && mode === "inline") ? undefined : { height }
        }
      >
        {mode !== "inline" && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-muted/40 px-4 text-center text-sm text-muted-foreground">
            <p>{placeholder}</p>
            <Button variant="ghost" size="sm" onClick={() => void show(app.viewId, "inline")}>
              {t("connectorApp.backToReply")}
            </Button>
          </div>
        )}
        {loaded._tag === "failed" ? (
          <p role="status" className="px-4 py-6 text-center text-sm text-muted-foreground">
            {t("connectorApp.failed")}
          </p>
        ) : loaded._tag === "loading" || live === null ? (
          mode === "inline" && <span aria-hidden className="skeleton absolute inset-3" />
        ) : (
          <AppStageFrame
            key={live.generation}
            app={app}
            view={loaded.view}
            document={loaded.document}
            access={access}
            stage={stage}
            mode={mode}
            height={height}
            leaving={live.leaving}
            onHeight={setHeight}
            onModes={setModes}
            onLeft={() => setLive(null)}
          />
        )}
      </div>
    </figure>
  );
}

/** Whose app it is: its connector's mark and name, the tool, and what the operator can do with it. */
function AppHeader({
  app,
  onExpand,
  onClose,
}: {
  readonly app: ConnectorAppRef;
  readonly onExpand?: () => void;
  readonly onClose?: () => void;
}) {
  const { t } = useI18n();
  return (
    <figcaption className="flex min-h-10 items-center gap-2 border-b border-border px-2.5 text-xs text-muted-foreground">
      <ConnectorTile name={app.connector} glyph={app.glyph} size="sm" />
      <span className="min-w-0 flex-1 truncate">
        <span className="font-medium text-foreground">{app.connector}</span>
        {" · "}
        {app.tool}
      </span>
      {onExpand !== undefined && (
        <Button
          variant="ghost-muted"
          size="icon-sm"
          aria-label={t("connectorApp.expand", { tool: app.tool })}
          onClick={onExpand}
        >
          <Maximize2Icon />
        </Button>
      )}
      {onClose !== undefined && (
        <Button
          variant="ghost-muted"
          size="icon-sm"
          aria-label={t("connectorApp.close", { tool: app.tool })}
          onClick={onClose}
        >
          <XIcon />
        </Button>
      )}
    </figcaption>
  );
}

/** Where a staged frame is drawn, in the coordinates `position: fixed` takes here. */
interface StageBox {
  /** The mode it was measured for: a box from the mode before is not this one's. */
  readonly mode: ConnectorAppDisplayMode;
  readonly top: number;
  readonly left: number;
  readonly width: number;
  readonly height: number | null;
}

/** How far a pinned app sits from the edges of the conversation, and how wide it gets, in CSS pixels. */
const PIN_MARGIN = 8;
const PIN_WIDTH = 560;

/**
 * Where a full-screen or pinned app's box goes: over the conversation's area,
 * or pinned at its top. `position: fixed` places it from its containing
 * block, which an ancestor's container query or transform can move off the
 * window's corner, so `probe`, a fixed point at 0, 0, says where that is.
 */
function useStageBox(
  mode: ConnectorAppDisplayMode,
  area: HTMLElement | null,
  probe: HTMLElement | null,
): StageBox | null {
  const [box, setBox] = useState<StageBox | null>(null);
  useLayoutEffect(() => {
    if (mode === "inline" || area === null || probe === null) return;
    const measure = () => {
      const room = area.getBoundingClientRect();
      const origin = probe.getBoundingClientRect();
      if (mode === "fullscreen") {
        setBox({
          mode,
          top: room.top - origin.top,
          left: room.left - origin.left,
          width: room.width,
          height: room.height,
        });
        return;
      }
      const width = Math.min(PIN_WIDTH, room.width - 2 * PIN_MARGIN);
      setBox({
        mode,
        top: room.top - origin.top + PIN_MARGIN,
        left: room.left - origin.left + (room.width - width) / 2,
        width,
        height: null,
      });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(area);
    window.addEventListener("resize", measure);
    // A row settling in moves what `fixed` is placed from, only while it plays.
    document.addEventListener("animationend", measure, true);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measure);
      document.removeEventListener("animationend", measure, true);
    };
  }, [mode, area, probe]);
  return mode === "inline" || area === null || probe === null || box?.mode !== mode ? null : box;
}

/** The frame's size as the page laid it out, and the mode it was laid out in. */
interface FrameSize {
  readonly mode: ConnectorAppDisplayMode;
  readonly width: number;
  readonly height: number;
}

/**
 * The frame's size, measured as soon as it is laid out in `shownIn`, before
 * the page is painted, and each time it changes. While `shownIn` is null, a
 * staged frame not placed yet, it keeps the size and mode it last had.
 */
function useFrameSize(element: HTMLElement | null, shownIn: ConnectorAppDisplayMode | null) {
  const [size, setSize] = useState<FrameSize>({ mode: "inline", width: 0, height: 0 });
  useLayoutEffect(() => {
    if (element === null || shownIn === null) return;
    const measure = () =>
      setSize({ mode: shownIn, width: element.clientWidth, height: element.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [element, shownIn]);
  return size;
}

/** Where the app is drawn, as it was last laid out: its mode and its room always come together. */
const displayOf = (size: FrameSize): ConnectorAppDisplay =>
  size.mode === "fullscreen"
    ? { mode: size.mode, width: size.width, height: size.height }
    : { mode: size.mode, width: size.width };

/**
 * The app's frame and what it asked of the operator, in one box that stays
 * in the reply's slot in every mode: in the reply it flows there; full
 * screen or pinned it is placed over the conversation. The frame is never
 * moved in the page, which would load it again.
 */
function AppStageFrame({
  app,
  view,
  document,
  access,
  stage,
  mode,
  height,
  leaving,
  onHeight,
  onModes,
  onLeft,
}: {
  readonly app: ConnectorAppRef;
  readonly view: ConnectorAppView;
  readonly document: string;
  readonly access: ConnectorAppAccess;
  readonly stage: AppStageState;
  readonly mode: ConnectorAppDisplayMode;
  readonly height: number;
  readonly leaving: boolean;
  readonly onHeight: (height: number) => void;
  readonly onModes: (modes: ReadonlyArray<ConnectorAppDisplayMode>) => void;
  readonly onLeft: () => void;
}) {
  const { t, locale } = useI18n();
  const { theme: appTheme } = usePreferences();
  // As a visual takes it: the gallery shows each theme side by side.
  const theme = useContext(VisualTheme) ?? appTheme;
  const { timeZone } = useClock();
  const frame = useRef<HTMLIFrameElement>(null);
  const shell = useRef<HTMLDivElement>(null);
  const host = useRef<ConnectorAppHost | null>(null);
  const [box, setBoxElement] = useState<HTMLDivElement | null>(null);
  const [probe, setProbe] = useState<HTMLSpanElement | null>(null);
  const [asks, setAsks] = useState<ReadonlyArray<Ask>>([]);
  // Writing the document loads the frame again, which is not another start.
  const posted = useRef(false);
  const stageBox = useStageBox(mode, stage.area, probe);
  // The app is told of a new mode only once its frame is laid out in it, with the room it has there.
  const size = useFrameSize(box, mode === "inline" || stageBox !== null ? mode : null);

  const place = useMemo<ConnectorAppPlace>(
    () => ({
      appearance: theme,
      locale,
      timeZone,
      platform: access.platform,
      touch: window.matchMedia("(pointer: coarse)").matches,
      hover: window.matchMedia("(hover: hover)").matches,
      display: displayOf(size),
      modes: stage.modes,
    }),
    [theme, locale, timeZone, access.platform, size, stage.modes],
  );
  const placeNow = useEffectEvent(() => place);
  const setMode = useEffectEvent((next: ConnectorAppDisplayMode) => stage.show(view.viewId, next));
  const heightChanged = useEffectEvent(onHeight);
  const modesChanged = useEffectEvent(onModes);

  useEffect(() => {
    let next = 0;
    const asked = <A,>(make: (id: number, done: (answer: A) => void) => Ask): Promise<A> =>
      new Promise<A>((resolve) => {
        const ask = make((next += 1), (answer) => {
          setAsks((pending) => pending.filter((other) => other !== ask));
          resolve(answer);
        });
        setAsks((pending) => [...pending, ask]);
      });
    const made = connectorAppHost({
      view,
      place: placeNow(),
      send: (message) => frame.current?.contentWindow?.postMessage(message, "*"),
      callTool: (name, args, allowed) => access.callTool(view.viewId, name, args, allowed),
      readResource: (uri) => access.readResource(view.viewId, uri),
      setContext: (context) => access.setContext(view.viewId, context),
      confirmCall: (tool) =>
        asked<ConnectorAppAsk>((id, done) => ({ _tag: "call", id, tool, done })),
      // Sent only when the operator presses Send, as their own message to the bot.
      proposeMessage: (text) =>
        asked<boolean>((id, done) => ({ _tag: "message", id, text, done })).then((send) =>
          send ? access.sendMessage(view.botId, text) : false,
        ),
      openLink: (url) =>
        asked<boolean>((id, done) => ({ _tag: "link", id, url, done })).then((open) => {
          if (open) access.openLink(url);
          return open;
        }),
      // Saved, or opened in the browser, only when the operator presses Save.
      download: (files) =>
        asked<boolean>((id, done) => ({
          _tag: "download",
          id,
          names: files.map((file) => file.name),
          done,
        })).then((save) => {
          if (!save) return false;
          access.save(files.flatMap((file) => (file._tag === "file" ? [file] : [])));
          for (const file of files) if (file._tag === "link") access.openLink(file.url);
          return true;
        }),
      setDisplayMode: (next) => setMode(next),
      onModes: (modes) => modesChanged(modes),
      onHeight: (reported) => heightChanged(reported),
    });
    host.current = made;
    const onMessage = (event: MessageEvent) => {
      if (fromOwnFrame(event, frame.current?.contentWindow)) made.receive(event.data);
    };
    window.addEventListener("message", onMessage);
    return () => {
      window.removeEventListener("message", onMessage);
      // Gone with its conversation: the frame goes now, told but not waited for.
      void made.teardown("The app is no longer shown.");
      host.current = null;
      // A question the app left open goes with it.
      setAsks([]);
    };
  }, [access, view]);

  // Out of the conversation's view: the app is told, and its frame goes once it answered.
  const left = useEffectEvent(onLeft);
  useEffect(() => {
    if (!leaving) return;
    let current = true;
    void (host.current?.teardown("The app scrolled out of view.") ?? Promise.resolve()).then(() => {
      if (current) left();
    });
    return () => {
      current = false;
    };
  }, [leaving]);

  // A new theme, language, size or mode reaches the app as a change of where it is drawn.
  useEffect(() => {
    host.current?.placeChanged(place);
  }, [place]);

  // Going full screen or pinned, and back to the reply, it settles into its new place.
  const shown = useRef(mode);
  useLayoutEffect(() => {
    const element = shell.current;
    if (element === null || shown.current === mode) return;
    shown.current = mode;
    play(
      element,
      [
        { opacity: 0, transform: "scale(0.98)" },
        { opacity: 1, transform: "none" },
      ],
      springs.soft,
    );
  }, [mode]);

  const staged = mode !== "inline" && stageBox !== null;
  const style: CSSProperties | undefined = staged
    ? {
        position: "fixed",
        top: stageBox.top,
        left: stageBox.left,
        width: stageBox.width,
        ...(stageBox.height === null ? {} : { height: stageBox.height }),
      }
    : undefined;
  const frameHeight =
    mode === "inline"
      ? height
      : mode === "pip"
        ? Math.min(height, MAX_CONNECTOR_APP_PIP_HEIGHT)
        : null;

  return (
    <>
      {mode !== "inline" && (
        <span
          ref={setProbe}
          aria-hidden
          className="pointer-events-none fixed top-0 left-0 size-0"
        />
      )}
      <div
        ref={shell}
        style={style}
        className={cn(
          "flex flex-col",
          staged && "z-30 overflow-hidden bg-surface",
          mode === "pip" && "rounded-bubble border border-border shadow-overlay",
          // Until it is placed, a staged app is not drawn, and takes no room in the reply.
          mode !== "inline" && !staged && "invisible absolute inset-x-0 top-0",
        )}
        {...(mode === "fullscreen"
          ? {
              role: "dialog",
              "aria-label": t("connectorApp.title", { tool: app.tool, connector: app.connector }),
            }
          : {})}
      >
        {mode !== "inline" && (
          <AppHeader
            app={app}
            {...(mode === "pip" && place.modes.includes("fullscreen")
              ? { onExpand: () => void stage.show(view.viewId, "fullscreen") }
              : {})}
            onClose={() => void stage.show(view.viewId, "inline")}
          />
        )}
        <div
          ref={setBoxElement}
          className={cn("relative min-h-0", mode === "fullscreen" && "flex-1")}
          style={frameHeight === null ? undefined : { height: frameHeight }}
        >
          <iframe
            ref={frame}
            src={CONNECTOR_APP_FRAME_PATH}
            sandbox={CONNECTOR_APP_FRAME_SANDBOX}
            allow=""
            title={t("connectorApp.title", { tool: app.tool, connector: app.connector })}
            referrerPolicy="no-referrer"
            className="block size-full border-0"
            onLoad={(event) => {
              // The first load is the empty app page, ready for its document.
              if (posted.current) return;
              posted.current = true;
              event.currentTarget.contentWindow?.postMessage(document, "*");
            }}
          />
          {mode === "fullscreen" && <ReplySheet stage={stage} />}
        </div>
        {asks.map((ask) => (
          <AskLine key={ask.id} ask={ask} connector={app.connector} />
        ))}
      </div>
    </>
  );
}

/**
 * What the bots said since the app went full screen, over its lower part,
 * so the operator reads it without closing the app. Hidden until the next.
 */
function ReplySheet({ stage }: { readonly stage: AppStageState }) {
  const { t } = useI18n();
  const bots = useBots();
  const latest = stage.replies.at(-1) ?? null;
  const [hidden, setHidden] = useState<string | null>(null);
  const sheet = useRef<HTMLDivElement>(null);
  const shownId = latest === null || hidden === latest.id ? null : latest.id;
  useLayoutEffect(() => {
    const element = sheet.current;
    if (element === null || shownId === null) return;
    play(
      element,
      [
        { opacity: 0, transform: "translateY(16px)" },
        { opacity: 1, transform: "none" },
      ],
      springs.slide,
    );
  }, [shownId]);
  if (latest === null || shownId === null) return null;
  const name =
    latest.author._tag === "bot"
      ? (bots.get(latest.author.botId)?.profile.name ?? t("bot.unknown"))
      : null;
  return (
    <div
      ref={sheet}
      role="status"
      className="absolute inset-x-3 bottom-3 flex max-h-[45%] flex-col gap-1 overflow-y-auto rounded-bubble border border-border bg-surface p-3 text-sm text-foreground shadow-overlay"
    >
      <div className="flex items-center gap-2">
        {name !== null && <p className="min-w-0 flex-1 truncate text-xs font-medium">{name}</p>}
        <Button variant="ghost-muted" size="sm" onClick={() => setHidden(latest.id)}>
          {t("connectorApp.hideReply")}
        </Button>
      </div>
      <MessageText text={latest.text} />
    </div>
  );
}

/** What the app asked of the operator, and the buttons that answer it. The app cannot reach this line. */
function AskLine({ ask, connector }: { readonly ask: Ask; readonly connector: string }) {
  const { t } = useI18n();
  const line = (text: string, yes: string, no: string, answer: (yes: boolean) => void) => (
    <div className="flex flex-col gap-2 border-t border-border bg-surface px-3 py-2.5 text-sm">
      <p className="wrap-break-word">{text}</p>
      <div className="flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={() => answer(false)}>
          {no}
        </Button>
        <Button size="sm" onClick={() => answer(true)}>
          {yes}
        </Button>
      </div>
    </div>
  );
  switch (ask._tag) {
    case "call":
      return line(
        t("connectorApp.askCall", { tool: ask.tool, connector }),
        t("connectorApp.allow"),
        t("connectorApp.deny"),
        (yes) => ask.done(yes ? "allowed" : "declined"),
      );
    case "message":
      return line(
        t("connectorApp.askMessage", { text: ask.text }),
        t("connectorApp.send"),
        t("connectorApp.dismiss"),
        (yes) => ask.done(yes),
      );
    case "link":
      return line(
        t("connectorApp.askLink", { url: ask.url.href }),
        t("connectorApp.open"),
        t("connectorApp.dismiss"),
        (yes) => ask.done(yes),
      );
    case "download":
      return line(
        t("connectorApp.askDownload", { names: ask.names.join(", ") }),
        t("connectorApp.save"),
        t("connectorApp.dismiss"),
        (yes) => ask.done(yes),
      );
  }
}
