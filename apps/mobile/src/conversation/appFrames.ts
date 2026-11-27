// SPDX-License-Identifier: AGPL-3.0-or-later
import { type NativeModule, requireNativeView, requireOptionalNativeModule } from "expo";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type { ViewProps } from "react-native";

// The app's own module for connector apps (modules/connector-app-view), on
// Android only. Each app runs in a frame of its own, keyed by the app, which
// outlives the view it is drawn in: a `NativeAppFrame` with its key shows it,
// wherever it is, and only `closeFrame` ends it. What a frame says crosses
// from Kotlin, so it is decoded before anything reads it.

declare class ConnectorAppFramesModule extends NativeModule<{
  onAppMessage: (event: unknown) => void;
  onPageFailed: (event: unknown) => void;
}> {
  deliver(key: string, message: string): Promise<void>;
  close(key: string): Promise<void>;
}

const native = requireOptionalNativeModule<ConnectorAppFramesModule>("ConnectorAppView");

type NativeAppFrameProps = ViewProps & {
  /** The frame's key, from `frameKey`. */
  readonly appKey: string;
  /** The page, as `connectorAppShell` wraps the app's: loaded once, as the frame is made. */
  readonly document: string;
};

/** Where an app's frame is drawn; null in a build without the module, where no app can show. */
export const NativeAppFrame =
  native === null ? null : requireNativeView<NativeAppFrameProps>("ConnectorAppView");

interface FrameListener {
  /** A message of the app's, as JSON; anything that is not JSON is none of the protocol. */
  readonly message: (data: unknown) => void;
  readonly failed: () => void;
}

const listeners = new Map<string, FrameListener>();

const decodeMessage = Schema.decodeUnknownOption(
  Schema.Struct({ key: Schema.String, data: Schema.String }),
);
const decodeFailure = Schema.decodeUnknownOption(Schema.Struct({ key: Schema.String }));

const parsed = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

native?.addListener("onAppMessage", (event) => {
  Option.map(decodeMessage(event), ({ key, data }) => listeners.get(key)?.message(parsed(data)));
});
native?.addListener("onPageFailed", (event) => {
  Option.map(decodeFailure(event), ({ key }) => listeners.get(key)?.failed());
});

let made = 0;

/** A key no other frame of this run has, for the app's next frame. */
export const frameKey = (viewId: string): string => {
  made += 1;
  return `${viewId}~${made}`;
};

/** Hears what the frame of `key` says, until the frame closes. */
export const listenToFrame = (key: string, listener: FrameListener): void => {
  listeners.set(key, listener);
};

/** Hands the app in the frame of `key` one message of the host's. */
export const deliverToFrame = (key: string, message: unknown): void => {
  void native?.deliver(key, JSON.stringify(message)).catch(() => undefined);
};

/** Ends the frame of `key`: nothing of its app runs after. */
export const closeFrame = (key: string): void => {
  listeners.delete(key);
  void native?.close(key).catch(() => undefined);
};
