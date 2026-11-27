// SPDX-License-Identifier: AGPL-3.0-or-later
import * as Effect from "effect/Effect";
import {
  connectX,
  getSelectionOwner,
  internAtom,
  readUint32,
  VALUE_AT,
  type XConnection,
  xServerHere,
} from "./x11.ts";

// Whether a window here can be see-through. Windows and macOS always
// composite their windows, and so does every Wayland desktop. On X11 a
// compositing manager may or may not run, and without one a transparent
// window shows black where it should show what is behind it. Electron does
// not say which, so the app asks the X server what the window manager spec
// has a compositing manager declare: it owns the selection `_NET_WM_CM_S<n>`
// of each screen it composites (EWMH, "Compositing Managers").

/**
 * Whether a compositing manager runs on `screen` of the X server `x` is
 * connected to: `null` when the server did not say.
 */
export const compositesOn = (x: XConnection, screen: number): Effect.Effect<boolean | null> =>
  Effect.gen(function* () {
    // Only if it exists: an atom nobody made is a selection nobody owns.
    const atom = yield* x.ask(internAtom(`_NET_WM_CM_S${screen}`, true));
    if (atom === null) return null;
    const selection = readUint32(atom, VALUE_AT);
    if (selection === 0) return false;
    const owner = yield* x.ask(getSelectionOwner(selection));
    return owner === null ? null : readUint32(owner, VALUE_AT) !== 0;
  });

/**
 * Whether a compositing manager runs on `screen` of the X server listening
 * at `path`: `null` when the server did not say, as when it refused the
 * connection, answered something else, or took longer than `timeoutMs`.
 */
export const compositingManagerRuns = (options: {
  readonly path: string;
  readonly screen: number;
  readonly cookie: Uint8Array | null;
  readonly timeoutMs: number;
}): Effect.Effect<boolean | null> =>
  Effect.gen(function* () {
    const x = yield* connectX(options);
    return x === null ? null : yield* compositesOn(x, options.screen);
  }).pipe(Effect.scoped);

/** How long the X server has to answer before the app goes on without knowing. */
const ASK_FOR = 500;

interface Here {
  readonly platform: NodeJS.Platform;
  readonly wayland: boolean;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly homeDirectory: string;
  readonly hostname: string;
}

/**
 * Whether a transparent window shows what is behind it here. On X11 the app
 * asks the server; where it cannot ask, or gets no answer, it takes there to
 * be a compositing manager, as nearly every desktop has one.
 */
export const transparencyHere = Effect.fn("desktop.transparencyHere")(function* (here: Here) {
  if (here.platform !== "linux" || here.wayland) return true;
  const server = yield* xServerHere(here);
  if (server === null) return true;
  const runs = yield* compositingManagerRuns({ ...server, timeoutMs: ASK_FOR });
  if (runs === null) {
    yield* Effect.logWarning(
      "The X server did not say whether a compositing manager runs; quick access takes it that one does",
    );
  }
  return runs ?? true;
});
