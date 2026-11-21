// SPDX-License-Identifier: AGPL-3.0-or-later
import { BRIDGE_KEY, ConnectResult, ForgetResult, HostedBridge } from "@j3-bots/desktop-bridge";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

/** What the desktop app offers the page it hosts. */
export interface Desktop {
  /** The server the operator named, or `null` until they have. */
  readonly server: URL | null;
  /**
   * Checks the address the operator typed and keeps it if a J3 Bots server
   * answers there. `null` when the app gave no answer the page understands.
   */
  readonly connect: (address: string) => Promise<ConnectResult | null>;
  /**
   * Forgets the server, with everything this page kept for it, and opens the
   * app's first page. Resolves `false` when the server is still kept.
   */
  readonly forgetServer: () => Promise<boolean>;
}

const decodeBridge = Schema.decodeUnknownOption(HostedBridge);
const decodeResult = Schema.decodeUnknownOption(ConnectResult);
const decodeForget = Schema.decodeUnknownOption(ForgetResult);
const hosted: unknown = Reflect.get(window, BRIDGE_KEY);

/**
 * The desktop app's bridge, when this page runs in it: its preload script
 * set one, and it decodes. In a browser, `null`.
 */
export const desktop: Desktop | null = Option.match(decodeBridge(hosted), {
  onNone: () => null,
  onSome: (bridge) => ({
    server: bridge.state.server === null ? null : new URL(bridge.state.server),
    connect: (address) =>
      Promise.resolve()
        .then(() => bridge.connect(address))
        .then(
          (answer) => Option.getOrNull(decodeResult(answer)),
          () => null,
        ),
    forgetServer: () =>
      Promise.resolve()
        .then(() => bridge.forgetServer())
        .then(
          (answer) => Option.getOrNull(decodeForget(answer)) === "forgotten",
          () => false,
        ),
  }),
});
