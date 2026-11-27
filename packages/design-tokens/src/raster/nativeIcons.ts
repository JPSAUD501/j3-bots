// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The icons that native builds read as files, which `scripts/generate.ts`
 * writes under `generated/icons`: electron-builder's for the desktop
 * packages (a set of PNGs for Linux, an icon file for Windows, a plate for
 * macOS), and Expo's for the phone's launcher icon, splash screen and
 * notification icon. The web app draws its own as it builds, with the same
 * `renderAppIcon`.
 */
import { iconArt } from "../appIconArt.ts";
import { hexColor } from "../color.ts";
import { colors } from "../tokens.ts";
import { desktopIcon, macIcon, renderAppIcon, type AppIcon } from "./appIcon.ts";
import { icoFile } from "./ico.ts";

/**
 * Android's adaptive icon is two 108 dp layers of which a mask shows the
 * middle 72 dp, and no more than the middle 66 dp for sure. The plate's
 * square is 86 dp of them: the mark, as the large drawing places it, then
 * keeps inside that 66 dp circle, and the plate's shading runs past the mask
 * for a launcher that moves the layers.
 */
const ADAPTIVE_WIDTH = 86 / 108;
/**
 * Android's splash screen shows its image in a 288 dp square, masked to a
 * 192 dp circle when the image has no background of its own: the mark's
 * square, corner to corner, stays well inside it.
 */
const SPLASH_WIDTH = 0.36;

/**
 * Android's status bar draws a notification's icon in a 24 dp square, from
 * its alpha alone, with the art in the 20 dp inside it: the mark alone spans
 * that. At 96 px it is the large drawing, the one whose light stands clear of
 * the j's stem, which in one color is all that keeps them two shapes.
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
  // iOS, and Android's launcher before adaptive icons, cut a square's corners themselves.
  ["square.png", png({ size: SOURCE, plate: { kind: "square" }, framing: "plate", width: 1 })],
  // iOS draws its dark icon's background itself: the mark alone, in its colors.
  ["square-dark.png", png({ size: SOURCE, plate: { kind: "none" }, framing: "plate", width: 1 })],
  [
    "square-tinted.png",
    png({
      size: SOURCE,
      plate: { kind: "none" },
      framing: "plate",
      width: 1,
      mark: "silhouette",
    }),
  ],
  // The adaptive icon's three layers: the plate, the mark over it, and the mark a launcher tints.
  [
    "adaptive-background.png",
    png({
      size: SOURCE,
      plate: { kind: "square" },
      framing: "plate",
      width: ADAPTIVE_WIDTH,
      mark: "none",
    }),
  ],
  [
    "adaptive-foreground.png",
    png({ size: SOURCE, plate: { kind: "none" }, framing: "plate", width: ADAPTIVE_WIDTH }),
  ],
  [
    "adaptive-monochrome.png",
    png({
      size: SOURCE,
      plate: { kind: "none" },
      framing: "plate",
      width: ADAPTIVE_WIDTH,
      mark: "silhouette",
    }),
  ],
  [
    "notification.png",
    png({
      size: NOTIFICATION_SIZE,
      plate: { kind: "none" },
      framing: "mark",
      width: NOTIFICATION_WIDTH,
      mark: "silhouette",
    }),
  ],
  // The mark alone on each theme's canvas, in that theme's colors.
  ...(["light", "dark"] as const).map(
    (theme) =>
      [
        `splash-${theme}.png`,
        png({
          size: SOURCE,
          plate: { kind: "none" },
          framing: "mark",
          width: SPLASH_WIDTH,
          theme,
        }),
      ] as const,
  ),
  // Colors as native configurations take them: the canvas, for the splash
  // screen's background; the accent, for what the system draws in the app's
  // own color (a dialog's buttons, a text cursor); and the mark's light,
  // which tints a notification's icon.
  [
    "colors.json",
    () => {
      const themed = (role: "background" | "accent") => ({
        light: hexColor(colors[role].light),
        dark: hexColor(colors[role].dark),
      });
      return `${JSON.stringify(
        {
          canvas: themed("background"),
          accent: themed("accent"),
          iconLight: hexColor(iconArt.light.color.dark),
        },
        null,
        2,
      )}\n`;
    },
  ],
];
