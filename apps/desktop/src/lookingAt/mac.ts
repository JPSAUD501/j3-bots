// SPDX-License-Identifier: AGPL-3.0-or-later
import type { QuickAccessPicture, ScreenAccess } from "@j3-bots/desktop-bridge";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import type { ChildProcessSpawner } from "effect/process/ChildProcessSpawner";
import { desktopCapturer, nativeImage, shell, systemPreferences } from "electron";
import { outputOf } from "../localServer/probe.ts";
import type { FrontWindow, WindowReader } from "./reader.ts";
import { pictureOf } from "./reader.ts";
import { lookingAtOf } from "./text.ts";

// macOS lists the windows on screen front to back (CGWindowListCopyWindowInfo,
// Core Graphics), each with its number, the app that owns it, and its title,
// which it gives only to an app the operator allowed under Screen Recording.
// The app asks through `osascript`, macOS's own JavaScript for Automation,
// and takes the first ordinary window (layer 0) of another process than its
// own: that is the one the operator was in, whether or not quick access has
// taken focus yet. A picture is macOS's own `screencapture` of that window
// by its number, which Screen Recording also gates.

/**
 * Prints the first ordinary window on screen of another process than
 * `argv[0]`, as JSON: its number, its app's name, and, when `argv[1]` is
 * "title", its title when macOS gives it. Options: on screen only (1),
 * without the desktop's own (16).
 */
const FRONT_WINDOW = `
ObjC.import("CoreGraphics");
function run(argv) {
  const own = Number(argv[0]);
  const withTitle = argv[1] === "title";
  const listed = ObjC.castRefToObject($.CGWindowListCopyWindowInfo(1 | 16, 0));
  if (!listed) return "null";
  // Each window's fields one by one: a title is never read unless asked for.
  const field = (window, key) => ObjC.deepUnwrap(window.objectForKey(key));
  for (let at = 0; at < listed.count; at++) {
    const window = listed.objectAtIndex(at);
    if (field(window, "kCGWindowLayer") !== 0 || field(window, "kCGWindowOwnerPID") === own) continue;
    const bounds = field(window, "kCGWindowBounds") || {};
    if (field(window, "kCGWindowAlpha") === 0 || !(bounds.Width > 1 && bounds.Height > 1)) continue;
    return JSON.stringify({
      number: field(window, "kCGWindowNumber"),
      app: field(window, "kCGWindowOwnerName") || null,
      title: withTitle ? field(window, "kCGWindowName") || null : null,
    });
  }
  return "null";
}
`;

const Listed = Schema.NullOr(
  Schema.Struct({
    number: Schema.Int.check(Schema.isGreaterThan(0)),
    app: Schema.NullOr(Schema.String),
    title: Schema.NullOr(Schema.String),
  }),
);
const decodeListed = Schema.decodeUnknownOption(Schema.fromJsonString(Listed));

/** How long `osascript` has to answer, the first time it loads the bridge included. */
const ASK_WITHIN = Duration.seconds(3);
/** How long `screencapture` has to write the picture. */
const PICTURE_WITHIN = Duration.seconds(5);

/** Where the operator allows Screen Recording, in System Settings. */
const SCREEN_RECORDING_SETTINGS =
  "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture";

const screenAccess = (): ScreenAccess =>
  systemPreferences.getMediaAccessStatus("screen") === "granted" ? "granted" : "needed";

export const macReader = Effect.fn("desktop.macReader")(function* (ownProcess: number) {
  const context = yield* Effect.context<FileSystem.FileSystem | Path.Path | ChildProcessSpawner>();

  const takePicture = Effect.fn("desktop.mac.takePicture")(
    function* (number: number) {
      if (screenAccess() !== "granted") return { _tag: "needs-permission" } as const;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const folder = yield* fs.makeTempDirectoryScoped({ prefix: "j3-bots-window-" });
      const file = path.join(folder, "window.png");
      // -x: no sound; -o: no shadow; -l: that window alone.
      yield* outputOf("/usr/sbin/screencapture", ["-x", "-o", `-l${number}`, "-t", "png", file], {
        deadline: PICTURE_WITHIN,
      });
      const bytes = yield* fs.readFile(file).pipe(Effect.option);
      return Option.match(bytes, {
        onNone: (): QuickAccessPicture => ({ _tag: "failed" }),
        onSome: (png) => pictureOf(nativeImage.createFromBuffer(Buffer.from(png))),
      });
    },
    Effect.scoped,
    Effect.orElseSucceed((): QuickAccessPicture => ({ _tag: "failed" })),
    Effect.provideContext(context),
  );

  const front = ({ withTitle }: { readonly withTitle: boolean }) =>
    outputOf(
      "/usr/bin/osascript",
      ["-l", "JavaScript", "-e", FRONT_WINDOW, String(ownProcess), withTitle ? "title" : "app"],
      { deadline: ASK_WITHIN },
    ).pipe(
      Effect.map((printed) => {
        const listed = Option.getOrNull(
          Option.flatMap(printed, (text) => decodeListed(text.trim())),
        );
        if (listed === null) return null;
        const lookingAt = lookingAtOf(listed.app, listed.title, withTitle);
        if (lookingAt === null) return null;
        return {
          lookingAt,
          picture: screenAccess() === "granted" ? "available" : "needs-permission",
          takePicture: takePicture(listed.number),
        } satisfies FrontWindow;
      }),
      Effect.provideContext(context),
    );

  return {
    reach: "window",
    // The list is in front-to-back order: quick access in front changes nothing.
    beforeFocus: Duration.zero,
    front,
    screen: Effect.sync(screenAccess),
    askScreenAccess: ({ first }) =>
      Effect.promise(async () => {
        // macOS asks the operator itself the first time an app reads the
        // screen; after that only System Settings changes the answer. Electron
        // reports either as not granted, so the app keeps whether it asked.
        if (first) {
          await desktopCapturer
            .getSources({ types: ["screen"], thumbnailSize: { width: 0, height: 0 } })
            .catch(() => []);
          return;
        }
        await shell.openExternal(SCREEN_RECORDING_SETTINGS).catch(() => undefined);
      }),
  } satisfies WindowReader;
});
