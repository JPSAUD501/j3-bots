// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  CONNECTOR_APP_DEFAULT_HEIGHT,
  type ConnectorAppAsk,
  type ConnectorAppHost,
  type ConnectorAppPlace,
  connectorAppDocument,
  connectorAppHost,
  connectorAppShell,
} from "@j3-bots/client-runtime/presentation";
import { useJ3Client, useReadable } from "@j3-bots/client-runtime/react";
import type { ConnectorAppRef, ConnectorAppView } from "@j3-bots/contracts";
import { requireNativeView, requireOptionalNativeModule } from "expo";
import { type Ref, use, useEffect, useEffectEvent, useMemo, useRef, useState } from "react";
import {
  Linking,
  type NativeSyntheticEvent,
  useColorScheme,
  View,
  type ViewProps,
} from "react-native";
import { useI18n } from "../i18n.ts";
import { session } from "../platform/platform.ts";
import { usePresentation } from "../presentation.tsx";
import { Text } from "../text.tsx";
import { Button } from "../ui.tsx";
import { EntryWidths } from "./widths.ts";

// A connector's app on Android: the interface a connector's server gave the
// tool a bot called, drawn under the turn's work in the app's own isolated
// view (`modules/connector-app-view`), inside `connectorAppShell`'s sandboxed
// frame. docs/architecture/security.md, "Connector apps", says what it can
// and cannot reach.

interface NativeAppHandle {
  readonly deliver: (message: string) => Promise<void>;
}

type NativeAppProps = ViewProps & {
  readonly ref?: Ref<NativeAppHandle>;
  readonly document: string;
  readonly onAppMessage: (event: NativeSyntheticEvent<{ readonly data: string }>) => void;
  readonly onPageFailed: (event: NativeSyntheticEvent<{ readonly cause: string }>) => void;
};

/** The app's own view for a connector's app, on Android only. Missing, an app says it could not be shown. */
const NativeAppView =
  requireOptionalNativeModule("ConnectorAppView") === null
    ? null
    : requireNativeView<NativeAppProps>("ConnectorAppView");

type Ask = { readonly id: number } & (
  | { readonly _tag: "call"; readonly tool: string; readonly done: (ask: ConnectorAppAsk) => void }
  | { readonly _tag: "message"; readonly text: string; readonly done: (send: boolean) => void }
  | { readonly _tag: "link"; readonly url: URL; readonly done: (open: boolean) => void }
);

/** A message the shell relayed, as JSON; anything that is not JSON is no message of the protocol. */
const parsed = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

type Loaded =
  | { readonly _tag: "loading" }
  | { readonly _tag: "ready"; readonly view: ConnectorAppView; readonly page: string }
  | { readonly _tag: "failed" };

/** Every app a turn's work shows, one under the other, below the fold's line. */
export function ConnectorApps({ apps }: { readonly apps: ReadonlyArray<ConnectorAppRef> }) {
  if (apps.length === 0) return null;
  return (
    <View className="mt-2 gap-3">
      {apps.map((app) => (
        <ConnectorAppCard key={app.viewId} app={app} />
      ))}
    </View>
  );
}

function ConnectorAppCard({ app }: { readonly app: ConnectorAppRef }) {
  const { t } = useI18n();
  const client = useJ3Client();
  const state = useReadable(session.state);
  // The server this client speaks to, which no app may reach; a conversation is shown only while there is one.
  const server = state._tag === "open" ? state.origin : null;
  const widths = use(EntryWidths);
  // A build without the view says at once that it cannot show the app.
  const [loaded, setLoaded] = useState<Loaded>(
    NativeAppView === null ? { _tag: "failed" } : { _tag: "loading" },
  );

  useEffect(() => {
    if (NativeAppView === null || server === null) return;
    let current = true;
    void client.connectors.app.open(app.viewId).then((result) => {
      if (!current) return;
      const document = result._tag === "done" ? connectorAppDocument(result.value, server) : null;
      setLoaded(
        result._tag === "done" && document !== null
          ? { _tag: "ready", view: result.value, page: connectorAppShell(document) }
          : { _tag: "failed" },
      );
    });
    return () => {
      current = false;
    };
  }, [client, server, app.viewId]);

  return (
    <View
      style={{ width: widths.card }}
      className="self-start overflow-hidden rounded-bubble border border-border bg-surface"
    >
      <View className="min-h-9 justify-center border-b border-border px-3">
        <Text numberOfLines={1} className="text-xs text-muted-foreground">
          {t("connectorApp.from", { tool: app.tool, connector: app.connector })}
        </Text>
      </View>
      {loaded._tag === "loading" ? (
        <View style={{ height: CONNECTOR_APP_DEFAULT_HEIGHT }} />
      ) : loaded._tag === "failed" ? (
        <Text className="px-4 py-6 text-center text-sm text-muted-foreground">
          {t("connectorApp.failed")}
        </Text>
      ) : (
        <AppFrame
          app={app}
          view={loaded.view}
          page={loaded.page}
          onFailed={() => setLoaded({ _tag: "failed" })}
        />
      )}
    </View>
  );
}

function AppFrame({
  app,
  view,
  page,
  onFailed,
}: {
  readonly app: ConnectorAppRef;
  readonly view: ConnectorAppView;
  readonly page: string;
  readonly onFailed: () => void;
}) {
  const { t, locale } = useI18n();
  const { timeZone } = usePresentation();
  const client = useJ3Client();
  const appearance = useColorScheme() === "dark" ? "dark" : "light";
  const native = useRef<NativeAppHandle>(null);
  const host = useRef<ConnectorAppHost | null>(null);
  const [width, setWidth] = useState(0);
  const [height, setHeight] = useState(CONNECTOR_APP_DEFAULT_HEIGHT);
  const [asks, setAsks] = useState<ReadonlyArray<Ask>>([]);

  const place = useMemo<ConnectorAppPlace>(
    () => ({
      appearance,
      locale,
      timeZone,
      platform: "mobile",
      touch: true,
      hover: false,
      width,
    }),
    [appearance, locale, timeZone, width],
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
    const answered = <A,>(
      result: { readonly _tag: "done"; readonly value: A } | { readonly _tag: "failed" },
    ) => (result._tag === "done" ? result.value : null);
    const made = connectorAppHost({
      view,
      place: placeNow(),
      send: (message) => void native.current?.deliver(JSON.stringify(message)),
      callTool: (name, args, allowed) =>
        client.connectors.app.callTool(view.viewId, name, args, allowed).then(answered),
      readResource: (uri) => client.connectors.app.readResource(view.viewId, uri).then(answered),
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
      onHeight: setHeight,
    });
    host.current = made;
    return () => {
      made.teardown("The app is no longer shown.");
      host.current = null;
      setAsks([]);
    };
  }, [client, view]);

  useEffect(() => {
    host.current?.placeChanged(place);
  }, [place]);

  if (NativeAppView === null) return null;
  return (
    <>
      <View
        style={{ height }}
        onLayout={(event) => setWidth(event.nativeEvent.layout.width)}
        accessibilityLabel={t("connectorApp.title", { tool: app.tool, connector: app.connector })}
      >
        <NativeAppView
          ref={native}
          document={page}
          onAppMessage={({ nativeEvent }) => host.current?.receive(parsed(nativeEvent.data))}
          onPageFailed={onFailed}
          style={{ flex: 1 }}
        />
      </View>
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
    <View className="gap-2 border-t border-border px-3 py-2.5">
      <Text className="text-sm text-foreground">{text}</Text>
      <View className="flex-row justify-end gap-2">
        <Button label={no} variant="plain" onPress={() => answer(false)} />
        <Button label={yes} variant="primary" onPress={() => answer(true)} />
      </View>
    </View>
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
