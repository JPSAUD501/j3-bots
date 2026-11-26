// SPDX-License-Identifier: AGPL-3.0-or-later
import type { ConnectorsClient } from "@j3-bots/client-runtime";
import type { ConnectorsOpening } from "@j3-bots/client-runtime/presentation";
import { type SignInRoute, useJ3Client, useReadable } from "@j3-bots/client-runtime/react";
import { useNavigation } from "@react-navigation/native";
import { Linking } from "react-native";
import { useI18n } from "../i18n.ts";
import type { Navigation } from "../navigation.tsx";
import { session } from "../platform/platform.ts";
import { openSignInPage, phoneSignInRoute } from "../platform/signInRelay.ts";

/**
 * What the connectors screens ask of the client runtime, and of the phone:
 * how a sign-in's browser comes back here (`signInRoute`), opening its page
 * (`openSignIn`) or a service's setup page (`openPage`), and opening the
 * operator's secrets (`openSecrets`) when a connector cannot read them.
 */
export interface ConnectorsIntents extends Omit<ConnectorsClient, "state"> {
  readonly signInRoute: SignInRoute;
  readonly openSignIn: (url: string) => void;
  readonly openPage: (url: string) => void;
  readonly openSecrets: () => void;
}

export function useConnectorsIntents(): ConnectorsIntents {
  const { locale } = useI18n();
  const navigation = useNavigation<Navigation>();
  const { state: _state, ...connectors } = useJ3Client().connectors;
  const server = useReadable(session.state);
  const viaHttps = server._tag === "open" && server.origin.protocol === "https:";
  return {
    ...connectors,
    signInRoute: phoneSignInRoute(locale, viaHttps),
    openSignIn: openSignInPage,
    openPage: (url) => {
      void Linking.openURL(url).catch(() => undefined);
    },
    // Secrets are on their page of Settings, over the connectors, which wait as they
    // were under it.
    openSecrets: () => navigation.push("settingsPage", { page: "secrets" }),
  };
}

/** Opens the connectors screens where `opening` says, over the screen shown now. */
export function useOpenConnectors(): (opening: ConnectorsOpening) => void {
  const navigation = useNavigation<Navigation>();
  return ({ at, forBot }) => {
    switch (at._tag) {
      case "home":
        navigation.push("connectors", { forBot });
        return;
      case "listing":
        navigation.push("connectorListing", {
          ref: at.ref,
          name: at.name,
          glyph: at.glyph,
          forBot,
        });
        return;
      case "connector":
        navigation.push("connector", {
          connectorId: at.connectorId,
          signIn: at.signIn,
          added: at.added,
        });
        return;
      case "add-own":
        navigation.push("addConnector", { forBot });
        return;
    }
  };
}
