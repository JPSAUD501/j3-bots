// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The icons that native builds read as files, which `scripts/generate.ts`
 * writes under `generated/icons`: electron-builder's for the desktop
 * packages (a set of PNGs for Linux, an icon file for Windows, a plate for
 * macOS), and Expo's for the phone's launcher icon, splash screen and
 * notification icon. The web app draws its own as it builds, with the same
 * `renderAppIcon`.
 */
import { hexColor } from "../color.ts";
import { colors } from "../tokens.ts";
import { desktopIcon, macIcon, renderAppIcon, type AppIcon } from "./appIcon.ts";
import { icoFile } from "./ico.ts";

/**
 * Android's adaptive icon is a 108 dp square of which only a 66 dp circle is
 * sure to show: the row's corners stay inside it.
 */
const ADAPTIVE_WIDTH = 0.55;
/** iOS and Android's legacy launcher cut the corners of a square themselves. */
const SQUARE_WIDTH = 0.7;
/**
 * Android's splash screen shows its image in a 288 dp square, masked to a
 * 192 dp circle when the image has no background of its own.
 */
const SPLASH_WIDTH = 0.6;

/**
 * Android's status bar draws a notification's icon in a 24 dp square, from
 * its alpha alone, with the art in the 20 dp inside it.
 */
const NOTIFICATION_WIDTH = 20 / 24;
/** The notification icon's side: 24 dp at Android's densest screens, which Expo scales down from. */
const NOTIFICATION_SIZE = 96;

/** The side of an image a build scales down from. */
const SOURCE = 1024;

/** The sizes of the Linux icon set. */
const DESKTOP_SIZES = [16, 24, 32, 48, 64, 128, 256, 512, 1024] as const;

/** The sizes in the Windows icon file: those Windows draws, up to the largest it holds. */
const WINDOWS_SIZES = [16, 20, 24, 32, 40, 48, 64, 128, 256] as const;

const png = (icon: AppIcon) => () => renderAppIcon(icon);

/** Each file by its path under `generated/icons`, with what writes it. */
export const nativeIconFiles: ReadonlyArray<
  readonly [path: string, body: () => string | Uint8Array]
> = [
  ...DESKTOP_SIZES.map((size) => [`desktop/${size}x${size}.png`, png(desktopIcon(size))] as const),
  [
    "desktop.ico",
    () => icoFile(WINDOWS_SIZES.map((size) => ({ size, png: renderAppIcon(desktopIcon(size)) }))),
  ],
  ["mac.png", png(macIcon(SOURCE))],
  [
    "square.png",
    png({
      size: SOURCE,
      theme: "light",
      plate: { kind: "square" },
      art: "ensemble",
      width: SQUARE_WIDTH,
    }),
  ],
  [
    "square-dark.png",
    png({
      size: SOURCE,
      theme: "dark",
      plate: { kind: "none" },
      art: "ensemble",
      width: SQUARE_WIDTH,
    }),
  ],
  [
    "square-tinted.png",
    png({
      size: SOURCE,
      theme: "light",
      plate: { kind: "none" },
      art: "ensemble",
      width: SQUARE_WIDTH,
      silhouette: true,
    }),
  ],
  [
    "adaptive-foreground.png",
    png({
      size: SOURCE,
      theme: "light",
      plate: { kind: "none" },
      art: "ensemble",
      width: ADAPTIVE_WIDTH,
    }),
  ],
  [
    "adaptive-monochrome.png",
    png({
      size: SOURCE,
      theme: "light",
      plate: { kind: "none" },
      art: "ensemble",
      width: ADAPTIVE_WIDTH,
      silhouette: true,
    }),
  ],
  // The lead alone, as the desktop's smallest icons show it: three shapes at
  // a status bar's size read as noise.
  [
    "notification.png",
    png({
      size: NOTIFICATION_SIZE,
      theme: "light",
      plate: { kind: "none" },
      art: "lead",
      width: NOTIFICATION_WIDTH,
      silhouette: true,
    }),
  ],
  [
    "splash-light.png",
    png({
      size: SOURCE,
      theme: "light",
      plate: { kind: "none" },
      art: "ensemble",
      width: SPLASH_WIDTH,
    }),
  ],
  [
    "splash-dark.png",
    png({
      size: SOURCE,
      theme: "dark",
      plate: { kind: "none" },
      art: "ensemble",
      width: SPLASH_WIDTH,
    }),
  ],
  // Colors as native configurations take them: the canvas, for the adaptive
  // icon's background and the splash screen's, and the accent, for what the
  // system draws in the app's own color (a dialog's buttons, a text cursor).
  [
    "colors.json",
    () => {
      const themed = (role: "background" | "accent") => ({
        light: hexColor(colors[role].light),
        dark: hexColor(colors[role].dark),
      });
      return `${JSON.stringify({ canvas: themed("background"), accent: themed("accent") }, null, 2)}\n`;
    },
  ],
];
