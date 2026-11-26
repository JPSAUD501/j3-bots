// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  type BotId,
  CONNECTOR_APP_FRAME_PATH,
  type ConnectorAppAnswer,
  type ConnectorAppRef,
  type ConnectorAppView,
  type ConnectorAppViewId,
} from "@j3-bots/contracts";
import {
  CONNECTOR_APP_DEFAULT_HEIGHT,
  CONNECTOR_APP_FRAME_SANDBOX,
  type ConnectorAppAsk,
  type ConnectorAppHost,
  type ConnectorAppPlace,
  connectorAppDocument,
  connectorAppHost,
  fromOwnFrame,
} from "@j3-bots/client-runtime/presentation";
import type * as Schema from "effect/Schema";
import { useEffect, useEffectEvent, useMemo, useRef, useState } from "react";
import { useI18n } from "../app/context";
import { useClock } from "../app/clock";
import { usePreferences } from "../preferences/preferences";
import { Button } from "./ui/button";

// A connector's app: the interface a connector's server gave the tool a bot
// called, drawn under the turn's work in a frame that shares nothing with
// the client. docs/architecture/security.md, "Connector apps", says how the
// frame is shut and what the app can still reach; docs/architecture/clients.md
// says how a client draws one.

/** What a timeline does for the apps its turns' work shows. */
export interface ConnectorAppAccess {
  /** The J3 Bots server the client speaks to, which no app may reach. */
  readonly server: URL;
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
  /** Sends `text` to the bot as the operator's own message; true once it went. */
  readonly sendMessage: (botId: BotId, text: string) => Promise<boolean>;
  /** Opens `url` in the operator's browser, outside the client. */
  readonly openLink: (url: URL) => void;
}

/** What the app asked that waits on the operator, in the client's own line under the frame. */
type Ask = { readonly id: number } & (
  | { readonly _tag: "call"; readonly tool: string; readonly done: (ask: ConnectorAppAsk) => void }
  | { readonly _tag: "message"; readonly text: string; readonly done: (send: boolean) => void }
  | { readonly _tag: "link"; readonly url: URL; readonly done: (open: boolean) => void }
);

type Loaded =
  | { readonly _tag: "loading" }
  | { readonly _tag: "ready"; readonly view: ConnectorAppView; readonly document: string }
  | { readonly _tag: "failed" };

/** Every app a turn's work shows, one under the other, below the fold's line. */
export function ConnectorApps({
  apps,
  access,
}: {
  readonly apps: ReadonlyArray<ConnectorAppRef>;
  readonly access: ConnectorAppAccess;
}) {
  if (apps.length === 0) return null;
  return (
    <div className="mt-2 flex flex-col gap-3">
      {apps.map((app) => (
        <ConnectorAppCard key={app.viewId} app={app} access={access} />
      ))}
    </div>
  );
}

/**
 * One app: whose it is, its frame, and below it what the app asked of the
 * operator. It is opened when drawn, and torn down when it leaves.
 */
function ConnectorAppCard({
  app,
  access,
}: {
  readonly app: ConnectorAppRef;
  readonly access: ConnectorAppAccess;
}) {
  const { t } = useI18n();
  const [loaded, setLoaded] = useState<Loaded>({ _tag: "loading" });

  useEffect(() => {
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
  }, [access, app.viewId]);

  return (
    <figure className="flex w-(--layout-card-width) max-w-full flex-col overflow-hidden rounded-bubble border border-border bg-surface">
      <figcaption className="flex min-h-9 items-center gap-1.5 border-b border-border px-3 text-xs text-muted-foreground">
        <span className="min-w-0 flex-1 truncate">
          {t("connectorApp.from", { tool: app.tool, connector: app.connector })}
        </span>
      </figcaption>
      {loaded._tag === "loading" ? (
        <div className="relative" style={{ height: CONNECTOR_APP_DEFAULT_HEIGHT }}>
          <span aria-hidden className="skeleton absolute inset-3" />
        </div>
      ) : loaded._tag === "failed" ? (
        <p role="status" className="px-4 py-6 text-center text-sm text-muted-foreground">
          {t("connectorApp.failed")}
        </p>
      ) : (
        <AppFrame app={app} view={loaded.view} document={loaded.document} access={access} />
      )}
    </figure>
  );
}

function AppFrame({
  app,
  view,
  document,
  access,
}: {
  readonly app: ConnectorAppRef;
  readonly view: ConnectorAppView;
  readonly document: string;
  readonly access: ConnectorAppAccess;
}) {
  const { t, locale } = useI18n();
  const { theme } = usePreferences();
  const { timeZone } = useClock();
  const frame = useRef<HTMLIFrameElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const host = useRef<ConnectorAppHost | null>(null);
  const [height, setHeight] = useState(CONNECTOR_APP_DEFAULT_HEIGHT);
  const [asks, setAsks] = useState<ReadonlyArray<Ask>>([]);
  // Writing the document loads the frame again, which is not another start.
  const posted = useRef(false);

  const [width, setWidth] = useState(0);
  const place = useMemo<ConnectorAppPlace>(
    () => ({
      appearance: theme,
      locale,
      timeZone,
      platform: "web",
      touch: window.matchMedia("(pointer: coarse)").matches,
      hover: window.matchMedia("(hover: hover)").matches,
      width,
    }),
    [theme, locale, timeZone, width],
  );
  const placeNow = useEffectEvent(() => place);

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
      onHeight: setHeight,
    });
    host.current = made;
    const onMessage = (event: MessageEvent) => {
      if (fromOwnFrame(event, frame.current?.contentWindow)) made.receive(event.data);
    };
    window.addEventListener("message", onMessage);
    return () => {
      window.removeEventListener("message", onMessage);
      made.teardown("The app is no longer shown.");
      host.current = null;
      // A question the app left open goes with it.
      setAsks([]);
    };
  }, [access, view]);

  // The frame's width, as the page lays it out.
  useEffect(() => {
    const element = box.current;
    if (element === null) return;
    const observer = new ResizeObserver(() => setWidth(element.clientWidth));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  // A new theme, language or width reaches the app as a change of where it is drawn.
  useEffect(() => {
    host.current?.placeChanged(place);
  }, [place]);

  return (
    <>
      <div ref={box} style={{ height }} className="relative">
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
      </div>
      {asks.map((ask) => (
        <AskLine key={ask.id} ask={ask} connector={app.connector} />
      ))}
    </>
  );
}

/** What the app asked of the operator, and the buttons that answer it. The app cannot reach this line. */
function AskLine({ ask, connector }: { readonly ask: Ask; readonly connector: string }) {
  const { t } = useI18n();
  const line = (text: string, yes: string, no: string, answer: (yes: boolean) => void) => (
    <div className="flex flex-col gap-2 border-t border-border px-3 py-2.5 text-sm">
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
  }
}
