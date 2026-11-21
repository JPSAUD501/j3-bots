// SPDX-License-Identifier: AGPL-3.0-or-later
import type { ConnectionState, J3Client, Readable, UnpairedReason } from "@j3-bots/client-runtime";
import { J3ClientProvider, useReadable } from "@j3-bots/client-runtime/react";
import { StatusBar } from "expo-status-bar";
import { type ReactNode, useState } from "react";
import { View } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
// The tokens' theme and the utilities every className names.
import "../global.css";
import { ChangeServer } from "./ChangeServer.tsx";
import { deviceI18n, I18nContext, useI18n } from "./i18n.ts";
import { Main } from "./navigation.tsx";
import { PairingScreen } from "./screens/Pairing.tsx";
import { session, type SessionState } from "./session.ts";
import { Body, Button, Centered, Title } from "./ui.tsx";

/** What the app shows, from the session and its client's connection. */
type Shown =
  | { readonly _tag: "starting" }
  | { readonly _tag: "pairing"; readonly server: URL | null; readonly reason: UnpairedReason }
  | { readonly _tag: "incompatible"; readonly server: URL; readonly client: J3Client }
  | { readonly _tag: "storage-failed"; readonly retry: () => void }
  | { readonly _tag: "main"; readonly server: URL; readonly client: J3Client };

const shownOf = (
  state: SessionState,
  pairing: boolean,
  leaving: boolean,
  connection: ConnectionState | null,
): Shown => {
  if (state._tag === "starting") return { _tag: "starting" };
  if (state._tag === "unreadable") {
    return { _tag: "storage-failed", retry: () => void session.start() };
  }
  // Signed out of a server being left: nothing until the app has let go of it.
  if (leaving && connection?._tag === "unpaired") return { _tag: "starting" };
  const reason = connection?._tag === "unpaired" ? connection.reason : "new";
  // A pairing under way keeps the pairing screen, and what was typed on it,
  // while the client of a newly named server starts.
  if (state._tag === "none" || pairing) {
    return { _tag: "pairing", server: state._tag === "open" ? state.origin : null, reason };
  }
  const { origin: server, client } = state;
  switch (connection?._tag) {
    case undefined:
    case "starting":
      return { _tag: "starting" };
    case "unpaired":
      return { _tag: "pairing", server, reason };
    case "incompatible":
      return { _tag: "incompatible", server, client };
    case "storage-failed":
      return { _tag: "storage-failed", retry: client.reconnectNow };
    case "offline":
    case "connecting":
    case "waiting":
    case "connected":
      return { _tag: "main", server, client };
  }
};

const NO_CONNECTION: Readable<null> = { get: () => null, subscribe: () => () => undefined };

function Gate(props: {
  readonly title: string;
  readonly body: string;
  readonly retry: () => void;
  readonly children?: ReactNode;
}) {
  const { t } = useI18n();
  return (
    <Centered>
      <Title>{props.title}</Title>
      <Body>{props.body}</Body>
      <Button variant="primary" label={t("gate.retry")} onPress={props.retry} />
      {props.children}
    </Centered>
  );
}

function Root() {
  const { t } = useI18n();
  const state = useReadable(session.state);
  const pairing = useReadable(session.pairing);
  const leaving = useReadable(session.leaving);
  const source: Readable<ConnectionState | null> =
    state._tag === "open" ? state.client.connection : NO_CONNECTION;
  const shown = shownOf(state, pairing, leaving, useReadable(source));
  switch (shown._tag) {
    case "starting":
      return <View className="flex-1 bg-background" />;
    case "pairing":
      return <PairingScreen server={shown.server} reason={shown.reason} />;
    case "incompatible":
      return (
        <Gate
          title={t("gate.incompatible.appTitle")}
          body={t("gate.incompatible.appBody", { address: shown.server.host })}
          retry={shown.client.reconnectNow}
        >
          <ChangeServer />
        </Gate>
      );
    case "storage-failed":
      return (
        <Gate
          title={t("gate.storage.mobileTitle")}
          body={t("gate.storage.mobileBody")}
          retry={shown.retry}
        />
      );
    case "main":
      return (
        <J3ClientProvider key={shown.server.origin} client={shown.client}>
          <Main />
        </J3ClientProvider>
      );
  }
}

/** Light and dark follow the system; the language is the device's. */
export function App() {
  const [i18n] = useState(deviceI18n);
  return (
    <I18nContext value={i18n}>
      <SafeAreaProvider>
        <StatusBar />
        <Root />
      </SafeAreaProvider>
    </I18nContext>
  );
}
