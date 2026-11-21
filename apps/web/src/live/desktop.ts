// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  BRIDGE_KEY,
  ConnectResult,
  ForgetResult,
  HostedBridge,
  HostedUpload,
  NetworkState,
  OpenResult,
  SealResult,
  type TokenProtection,
  UploadOutcome,
  UploadProgress,
  type UploadRequest,
} from "@j3-bots/desktop-bridge";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

/** A token as the desktop app sealed it, and how it is kept. */
interface SealedToken {
  readonly sealed: string;
  readonly protection: TokenProtection;
}

/** The server's answer to an upload, before the page reads it. */
export type UploadAnswer = Extract<UploadOutcome, { readonly _tag: "answered" }>;

const isAnswer = (outcome: UploadOutcome): outcome is UploadAnswer => outcome._tag === "answered";

/** An upload under way in the desktop app. */
interface DesktopUpload {
  /** The server's answer, or `null` when the upload did not reach it or no answer came back. */
  readonly done: Promise<UploadAnswer | null>;
  readonly abort: () => void;
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
  /** Sends `body` as `request` asks, through the app, calling `onProgress` with the bytes sent so far. */
  readonly upload: (
    request: UploadRequest,
    body: Blob,
    onProgress: (sent: number) => void,
  ) => DesktopUpload;
}

const decodeBridge = Schema.decodeUnknownOption(HostedBridge);
const decodeResult = Schema.decodeUnknownOption(ConnectResult);
const decodeForget = Schema.decodeUnknownOption(ForgetResult);
const decodeSeal = Schema.decodeUnknownOption(SealResult);
const decodeOpen = Schema.decodeUnknownOption(OpenResult);
const decodeNetwork = Schema.decodeUnknownOption(NetworkState);
const decodeUpload = Schema.decodeUnknownOption(HostedUpload);
const decodeProgress = Schema.decodeUnknownOption(UploadProgress);
const decodeOutcome = Schema.decodeUnknownOption(UploadOutcome);
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
    upload: (request, body, onProgress) => {
      const handle = Option.flatMap(
        Option.liftThrowable(() =>
          bridge.upload(request, body, (sent: unknown) =>
            Option.map(decodeProgress(sent), onProgress),
          ),
        )(),
        decodeUpload,
      );
      return Option.match(handle, {
        onNone: () => ({ done: Promise.resolve(null), abort: () => undefined }),
        onSome: ({ done, abort }) => ({
          done: done.then(
            (outcome) => Option.getOrNull(Option.filter(decodeOutcome(outcome), isAnswer)),
            () => null,
          ),
          abort: () => {
            abort();
          },
        }),
      });
    },
  }),
});
