// SPDX-License-Identifier: AGPL-3.0-or-later
import type { QuickAccessPicture } from "@j3-bots/desktop-bridge";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import type * as Path from "effect/Path";
import {
  connectX,
  getGeometry,
  getImage,
  getProperty,
  getWindowAttributes,
  internAtom,
  parseSetup,
  propertyOf,
  readUint8,
  readUint16,
  readUint32,
  VALUE_AT,
  type XConnection,
  type XServer,
  type XSetup,
} from "../x11.ts";
import { compositesOn } from "../compositing.ts";
import { appNameFor, entryFolders, type WindowClass, windowClassOf } from "./desktopEntries.ts";
import type { FrontWindow, WindowReader } from "./reader.ts";
import { lookingAtOf } from "./text.ts";

// On X11 the window manager names the window in front on the root window
// (`_NET_ACTIVE_WINDOW`, EWMH), and each window holds its title
// (`_NET_WM_NAME`, or the older `WM_NAME`) and its class (`WM_CLASS`).
// The app reads them on the display's socket, before quick access takes
// focus. A picture is the window's own pixels (GetImage), which a
// compositing manager keeps whole even where another window covers them;
// without one, what is covered is not kept, so there is no picture then.

/** Atoms the X protocol defines with fixed numbers. */
const ATOM = { STRING: 31, WM_NAME: 39, WM_CLASS: 67 } as const;
/** GetProperty's AnyPropertyType: a property of whatever type it holds. */
const ANY_TYPE = 0;

/** How long the X server has to answer each request before nothing is read. */
const ASK_FOR = 500;

/** The most of a title the app asks for, in four-byte units: past the longest a chip shows. */
const TITLE_UNITS = 512;

/** A window's pixels as a `width` by `height` bitmap of blue, green, red and alpha, opaque. */
export const bgraOf = (
  data: Uint8Array,
  width: number,
  height: number,
  byteOrder: XSetup["imageByteOrder"],
): Uint8Array | null => {
  const length = width * height * 4;
  if (data.length < length) return null;
  const bitmap = new Uint8Array(length);
  for (let at = 0; at < length; at += 4) {
    // A pixel 0x00RRGGBB, least significant byte first or last.
    const [blue, green, red] =
      byteOrder === "lsb"
        ? [data[at] ?? 0, data[at + 1] ?? 0, data[at + 2] ?? 0]
        : [data[at + 3] ?? 0, data[at + 2] ?? 0, data[at + 1] ?? 0];
    bitmap[at] = blue;
    bitmap[at + 1] = green;
    bitmap[at + 2] = red;
    bitmap[at + 3] = 255;
  }
  return bitmap;
};

/** Whether `visual` holds red, green and blue in the three low bytes of a 32-bit pixel. */
const plainVisual = (setup: XSetup, depth: number, visualId: number): boolean => {
  if (setup.bitsPerPixel.get(depth) !== 32) return false;
  const visual = setup.screens.flatMap((screen) => screen.visuals).find((v) => v.id === visualId);
  return (
    visual !== undefined &&
    visual.red === 0xff0000 &&
    visual.green === 0x00ff00 &&
    visual.blue === 0x0000ff
  );
};

/** Makes a picture of a `width` by `height` bitmap of blue, green, red and alpha. */
export type PictureFrom = (bgra: Uint8Array, width: number, height: number) => QuickAccessPicture;

/** A picture of `window`, as its own pixels are now. */
const takePicture = Effect.fn("desktop.x11.takePicture")(function* (
  server: XServer,
  window: number,
  pictureFrom: PictureFrom,
) {
  const failed: QuickAccessPicture = { _tag: "failed" };
  const x = yield* connectX({ ...server, timeoutMs: ASK_FOR });
  const setup = x === null ? null : parseSetup(x.setup);
  if (x === null || setup === null) return failed;
  const attributes = yield* x.ask(getWindowAttributes(window));
  const geometry = yield* x.ask(getGeometry(window));
  // Only a window on screen (map state 2, viewable) has pixels to take.
  if (attributes === null || geometry === null || readUint8(attributes, 26) !== 2) return failed;
  const depth = readUint8(geometry, 1);
  const width = readUint16(geometry, 16);
  const height = readUint16(geometry, 18);
  if (width === 0 || height === 0 || !plainVisual(setup, depth, readUint32(attributes, 8))) {
    return failed;
  }
  const image = yield* x.ask(getImage(window, width, height));
  if (image === null) return failed;
  const bitmap = bgraOf(image.subarray(32), width, height, setup.imageByteOrder);
  if (bitmap === null) return failed;
  return pictureFrom(bitmap, width, height);
}, Effect.scoped);

/** The atoms the reader asks by name, `0` for one nobody made. */
const atomsOf = Effect.fn("desktop.x11.atomsOf")(function* (x: XConnection) {
  const atom = (name: string) =>
    x
      .ask(internAtom(name, true))
      .pipe(Effect.map((reply) => (reply === null ? 0 : readUint32(reply, VALUE_AT))));
  return {
    active: yield* atom("_NET_ACTIVE_WINDOW"),
    name: yield* atom("_NET_WM_NAME"),
    utf8: yield* atom("UTF8_STRING"),
  };
});

/** A property's value, as bytes; `null` when the window has none of type `type`. */
const valueOf = (x: XConnection, window: number, property: number, type: number, units: number) =>
  property === 0 || type === 0
    ? Effect.succeed(null)
    : x.ask(getProperty(window, property, type, units)).pipe(
        Effect.map((reply) => {
          const held = reply === null ? null : propertyOf(reply);
          // Of another type, the server answers which, and no value.
          return held === null || held.type !== type ? null : held.value;
        }),
      );

/**
 * The window a property names, as a 32-bit value of any type: EWMH has
 * `_NET_ACTIVE_WINDOW` be a `WINDOW`, and some window managers and tools
 * write it as a `CARDINAL`. `null` for none, or for no window (0).
 */
const windowIn = (x: XConnection, window: number, property: number) =>
  property === 0
    ? Effect.succeed(null)
    : x.ask(getProperty(window, property, ANY_TYPE, 1)).pipe(
        Effect.map((reply) => {
          const held = reply === null ? null : propertyOf(reply);
          if (held === null || held.format !== 32 || held.value.length < 4) return null;
          const named = readUint32(held.value, 0);
          return named === 0 ? null : named;
        }),
      );

/**
 * Reads the window in front on the X server `server` describes. `appName`
 * finds the name a window's app goes by; `pictureFrom` makes a picture of
 * its pixels.
 */
export const x11Reader = (options: {
  readonly server: XServer;
  readonly appName: (window: WindowClass) => Effect.Effect<string | null>;
  readonly pictureFrom: PictureFrom;
}): WindowReader => {
  const { server, appName, pictureFrom } = options;
  const front = Effect.fn("desktop.x11.front")(function* ({
    withTitle,
  }: {
    readonly withTitle: boolean;
  }) {
    const x = yield* connectX({ ...server, timeoutMs: ASK_FOR });
    const setup = x === null ? null : parseSetup(x.setup);
    const root = setup?.screens[server.screen]?.root;
    if (x === null || root === undefined) return null;
    const atoms = yield* atomsOf(x);
    const window = yield* windowIn(x, root, atoms.active);
    if (window === null) return null;
    const windowClass = windowClassOf(
      (yield* valueOf(x, window, ATOM.WM_CLASS, ATOM.STRING, 64)) ?? new Uint8Array(),
    );
    if (windowClass === null) return null;
    const title = withTitle
      ? ((yield* valueOf(x, window, atoms.name, atoms.utf8, TITLE_UNITS).pipe(
          Effect.map((value) => (value === null ? null : new TextDecoder().decode(value))),
        )) ??
        (yield* valueOf(x, window, ATOM.WM_NAME, ATOM.STRING, TITLE_UNITS).pipe(
          Effect.map((value) => (value === null ? null : new TextDecoder("latin1").decode(value))),
        )))
      : null;
    const lookingAt = lookingAtOf(
      (yield* appName(windowClass)) ?? windowClass.className,
      title,
      withTitle,
    );
    if (lookingAt === null) return null;
    const composited = yield* compositesOn(x, server.screen);
    return {
      lookingAt,
      picture: composited === true ? "available" : "none",
      takePicture: takePicture(server, window, pictureFrom),
    } satisfies FrontWindow;
  }, Effect.scoped);
  return {
    reach: "window",
    beforeFocus: Duration.millis(150),
    front,
    screen: Effect.succeed("not-needed"),
    askScreenAccess: Effect.void,
  };
};

/**
 * `appNameFor`, remembered by window class for as long as the app runs: an
 * app installed while it runs is named by its class until the app restarts.
 */
export const desktopAppNames = Effect.fn("desktop.desktopAppNames")(function* (options: {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly homeDirectory: string;
  readonly locale: string;
}) {
  const context = yield* Effect.context<FileSystem.FileSystem | Path.Path>();
  const folders = entryFolders(options.env, options.homeDirectory);
  const known = new Map<string, string | null>();
  return (window: WindowClass): Effect.Effect<string | null> => {
    const key = `${window.instance}\0${window.className}`;
    if (known.has(key)) return Effect.succeed(known.get(key) ?? null);
    return appNameFor(window, folders, options.locale).pipe(
      Effect.tap((name) => Effect.sync(() => known.set(key, name))),
      Effect.provideContext(context),
    );
  };
});
