// SPDX-License-Identifier: AGPL-3.0-or-later
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import { nativeImage } from "electron";
import { xServerHere } from "../x11.ts";
import { macReader } from "./mac.ts";
import { pictureOf, type WindowReader } from "./reader.ts";
import { windowsReader } from "./windows.ts";
import { desktopAppNames, x11Reader } from "./x11.ts";

export type { FrontWindow, WindowReader } from "./reader.ts";

/** Where no app may read another's window: nothing is read, and nothing shows. */
const nowhere: WindowReader = {
  reach: "none",
  beforeFocus: Duration.zero,
  front: () => Effect.succeed(null),
  screen: Effect.succeed("not-needed"),
  askScreenAccess: () => Effect.void,
};

/**
 * How quick access reads the window in front on this computer, while the
 * scope lasts. Wayland gives an app no other app's window, its title or its
 * pixels, without asking the operator through the desktop portal each time,
 * so there it reads nothing.
 */
export const readerHere = Effect.fn("desktop.readerHere")(function* (here: {
  readonly platform: NodeJS.Platform;
  readonly wayland: boolean;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly homeDirectory: string;
  readonly hostname: string;
  readonly locale: string;
  readonly ownProcess: number;
}) {
  switch (here.platform) {
    case "darwin":
      return yield* macReader(here.ownProcess);
    case "win32":
      return yield* windowsReader(here.ownProcess);
    case "linux": {
      if (here.wayland) return nowhere;
      const server = yield* xServerHere(here);
      if (server === null) return nowhere;
      return x11Reader({
        server,
        appName: yield* desktopAppNames(here),
        pictureFrom: (bgra, width, height) =>
          pictureOf(nativeImage.createFromBitmap(Buffer.from(bgra), { width, height })),
      });
    }
    default:
      return nowhere;
  }
});
