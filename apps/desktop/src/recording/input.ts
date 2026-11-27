// SPDX-License-Identifier: AGPL-3.0-or-later
// @effect-diagnostics nodeBuiltinImport:off -- A native module loads only through Node's own require.
import * as NodeModule from "node:module";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import { screen } from "electron";
import type { KeyDown } from "./keys.ts";

// Keys, clicks and the wheel anywhere on the desktop, while a recording
// runs, through libuiohook as `uiohook-napi` builds it (MIT, decision 0098):
// the one way an app reads global input on Windows, macOS and X11 without a
// helper of its own. Wayland gives no app other apps' input, and macOS gives
// it only to an app the operator allowed under Accessibility; the recorder
// does not start it there.
//
// The package's prebuilt binary for this system is copied beside the app's
// bundle (vite.config.ts) and loaded here, without the package's JavaScript,
// which finds its binary by its own folder: the binary's `start(handler)`
// calls `handler` with each event, and `stop()` ends them. Every event is
// decoded before it is used.
//
// The hook reports points in the system's own units: physical pixels on
// Windows and X11, macOS's points. A recording's screens are in Electron's
// (`Display.bounds`), so each point is turned into those first.

export type InputEvent =
  | { readonly kind: "key"; readonly key: KeyDown }
  | {
      readonly kind: "press";
      readonly button: number;
      readonly clicks: number;
      readonly point: { readonly x: number; readonly y: number };
    }
  | {
      readonly kind: "wheel";
      readonly point: { readonly x: number; readonly y: number };
      readonly vertical: boolean;
      readonly rotation: number;
    };

/** Where the binary for this system is, under the app's folder. */
export const hookBinary = (appPath: string, join: (...parts: ReadonlyArray<string>) => string) =>
  join(
    appPath,
    "dist",
    "native",
    "uiohook",
    "uiohook-napi",
    "prebuilds",
    `${process.platform}-${process.arch}`,
    "uiohook-napi.node",
  );

const Hook = Schema.Struct({
  start: Schema.declare(Predicate.isFunction),
  stop: Schema.declare(Predicate.isFunction),
});
const decodeHook = Schema.decodeUnknownOption(Hook);

// libuiohook's event types and its code for a vertical wheel turn.
const KEY_PRESSED = 4;
const MOUSE_PRESSED = 7;
const MOUSE_WHEEL = 11;
const VERTICAL = 3;

const Held = {
  shiftKey: Schema.Boolean,
  ctrlKey: Schema.Boolean,
  altKey: Schema.Boolean,
  metaKey: Schema.Boolean,
};
const RawEvent = Schema.Union([
  Schema.Struct({ type: Schema.Literal(KEY_PRESSED), keycode: Schema.Number, ...Held }),
  Schema.Struct({
    type: Schema.Literal(MOUSE_PRESSED),
    button: Schema.Number,
    clicks: Schema.Number,
    x: Schema.Number,
    y: Schema.Number,
  }),
  Schema.Struct({
    type: Schema.Literal(MOUSE_WHEEL),
    direction: Schema.Number,
    rotation: Schema.Number,
    x: Schema.Number,
    y: Schema.Number,
  }),
]);
const decodeEvent = Schema.decodeUnknownOption(RawEvent);

const toDesktop = (x: number, y: number) => {
  switch (process.platform) {
    case "win32":
      return screen.screenToDipPoint({ x, y });
    case "darwin":
      return { x, y };
    default: {
      // X11: Electron draws every screen at one scale.
      const scale = screen.getPrimaryDisplay().scaleFactor;
      return { x: x / scale, y: y / scale };
    }
  }
};

const eventOf = (raw: unknown): InputEvent | null =>
  Option.match(decodeEvent(raw), {
    onNone: () => null,
    onSome: (event): InputEvent => {
      switch (event.type) {
        case KEY_PRESSED:
          return {
            kind: "key",
            key: {
              code: event.keycode,
              shift: event.shiftKey,
              ctrl: event.ctrlKey,
              alt: event.altKey,
              meta: event.metaKey,
            },
          };
        case MOUSE_PRESSED:
          return {
            kind: "press",
            button: event.button,
            clicks: event.clicks,
            point: toDesktop(event.x, event.y),
          };
        case MOUSE_WHEEL:
          return {
            kind: "wheel",
            point: toDesktop(event.x, event.y),
            vertical: event.direction === VERTICAL,
            rotation: event.rotation,
          };
      }
    },
  });

/**
 * Hands every key pressed, button pressed and wheel turn to `listener`
 * until the scope closes. Fails when the hook cannot start here.
 */
export const listenToInput = Effect.fn("recording.listenToInput")(function* (
  binary: string,
  listener: (event: InputEvent) => void,
) {
  const hook = yield* Effect.try({
    try: (): unknown => NodeModule.createRequire(import.meta.url)(binary),
    catch: () => "unavailable" as const,
  }).pipe(
    Effect.flatMap((loaded) =>
      Effect.fromOption(decodeHook(loaded)).pipe(Effect.mapError(() => "unavailable" as const)),
    ),
  );
  yield* Effect.acquireRelease(
    Effect.try({
      try: () =>
        hook.start((raw: unknown) => {
          const event = eventOf(raw);
          if (event !== null) listener(event);
        }),
      catch: () => "unavailable" as const,
    }),
    () =>
      Effect.try({ try: () => hook.stop(), catch: () => "stopped" as const }).pipe(Effect.ignore),
  );
});
