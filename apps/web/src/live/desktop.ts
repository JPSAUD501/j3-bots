// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  BRIDGE_KEY,
  ConnectResult,
  ForgetResult,
  HostedBridge,
  NetworkState,
  OpenResult,
  SealResult,
  type TokenProtection,
  UpdateStatus,
} from "@j3-bots/desktop-bridge";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

/** A token as the desktop app sealed it, and how it is kept. */
interface SealedToken {
  readonly sealed: string;
  readonly protection: TokenProtection;
}

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
  /** Encrypts a device token for this profile; `null` when it could not. */
  readonly sealToken: (token: string) => Promise<SealedToken | null>;
  /**
   * The token `sealed` holds, `failed` when it is not one this profile
   * sealed, or `unavailable` when the app could not open it now, nor say.
   */
  readonly openToken: (sealed: string) => Promise<OpenResult>;
  /** Whether the system has a network; `null` when the app did not say. */
  readonly online: () => Promise<boolean | null>;
  /** Calls `listener` each time the system wakes from sleep; answers a function that stops it. */
  readonly onResumed: (listener: (online: boolean) => void) => () => void;
  /** Restarts the app, which keeps this page's storage. */
  readonly relaunch: () => void;
  /** Where updating the app stands; `null` when the app gave no answer the page understands. */
  readonly updateStatus: () => Promise<UpdateStatus | null>;
  /** Calls `listener` each time the update's status changes; answers a function that stops it. */
  readonly onUpdate: (listener: (status: UpdateStatus) => void) => () => void;
  /** Checks for an update now, unless one is on its way or ready. */
  readonly checkForUpdates: () => void;
  /** Restarts into the downloaded update, as soon as no save is under way. */
  readonly restartToUpdate: () => void;
  /** Tells the app whether a save is under way, which a restart waits for. */
  readonly reportSaving: (saving: boolean) => void;
}

const decodeBridge = Schema.decodeUnknownOption(HostedBridge);
const decodeResult = Schema.decodeUnknownOption(ConnectResult);
const decodeForget = Schema.decodeUnknownOption(ForgetResult);
const decodeSeal = Schema.decodeUnknownOption(SealResult);
const decodeOpen = Schema.decodeUnknownOption(OpenResult);
const decodeNetwork = Schema.decodeUnknownOption(NetworkState);
const decodeStatus = Schema.decodeUnknownOption(UpdateStatus);
const hosted: unknown = Reflect.get(window, BRIDGE_KEY);

/** What `call` answers, decoded; `null` when it throws, rejects or answers something else. */
const ask = <A>(call: () => unknown, decode: (answer: unknown) => Option.Option<A>) =>
  Promise.resolve()
    .then(call)
    .then(
      (answer) => Option.getOrNull(decode(answer)),
      () => null,
    );

/**
 * The desktop app's bridge, when this page runs in it: its preload script
 * set one, and it decodes. In a browser, `null`.
 */
export const desktop: Desktop | null = Option.match(decodeBridge(hosted), {
  onNone: () => null,
  onSome: (bridge) => ({
    server: bridge.state.server === null ? null : new URL(bridge.state.server),
    connect: (address) => ask(() => bridge.connect(address), decodeResult),
    forgetServer: () =>
      ask(() => bridge.forgetServer(), decodeForget).then((answer) => answer === "forgotten"),
    sealToken: (token) =>
      ask(() => bridge.sealToken(token), decodeSeal).then((answer) =>
        answer?._tag === "sealed" ? { sealed: answer.sealed, protection: answer.protection } : null,
      ),
    openToken: (sealed) =>
      ask(() => bridge.openToken(sealed), decodeOpen).then(
        (answer): OpenResult => answer ?? { _tag: "unavailable" },
      ),
    online: () =>
      ask(() => bridge.networkStatus(), decodeNetwork).then((answer) => answer?.online ?? null),
    onResumed: (listener) => {
      const stop: unknown = bridge.onResumed((state: unknown) =>
        Option.map(decodeNetwork(state), ({ online }) => listener(online)),
      );
      return () => {
        if (typeof stop === "function") stop();
      };
    },
    relaunch: () => {
      bridge.relaunch();
    },
    updateStatus: () => ask(() => bridge.updateStatus(), decodeStatus),
    onUpdate: (listener) => {
      const stop: unknown = bridge.onUpdate((status: unknown) =>
        Option.map(decodeStatus(status), listener),
      );
      return () => {
        if (typeof stop === "function") stop();
      };
    },
    checkForUpdates: () => {
      bridge.checkForUpdates();
    },
    restartToUpdate: () => {
      bridge.restartToUpdate();
    },
    reportSaving: (saving) => {
      bridge.reportSaving(saving);
    },
  }),
});
