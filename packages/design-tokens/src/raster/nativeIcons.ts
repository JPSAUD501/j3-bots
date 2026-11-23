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
import { botPalette } from "../botPalette.ts";
import { hexColor } from "../color.ts";
import { colors } from "../tokens.ts";
import { desktopIcon, macIcon, renderAppIcon, type AppIcon } from "./appIcon.ts";
import { icoFile } from "./ico.ts";

/**
 * Android's adaptive icon is a 108 dp square of which a mask shows the middle
 * 72 dp: the plate's frame spans that, and what lies past it shows only as
 * the launcher moves the icon.
 */
const ADAPTIVE_WIDTH = 72 / 108;
/**
 * A themed icon's mark stays inside the 66 dp circle every mask keeps, with
 * room around it, as the system's own icons leave.
 */
const MONOCHROME_WIDTH = (66 / 108) * 0.82;
/**
 * Android's splash screen shows its image in a 288 dp square, masked to a
 * 192 dp circle when the image has no background of its own: the Pip whole
 * stays well inside it.
 */
const SPLASH_WIDTH = 0.5;

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
  // iOS, and Android's launcher before adaptive icons, cut a square's corners themselves.
  ["square.png", png({ size: SOURCE, plate: { kind: "square" }, framing: "plate", width: 1 })],
  // iOS draws its dark icon's background itself: the Pip alone, in the dark palette.
  [
    "square-dark.png",
    png({ size: SOURCE, plate: { kind: "none" }, framing: "plate", width: 1, theme: "dark" }),
  ],
  [
    "square-tinted.png",
    png({ size: SOURCE, plate: { kind: "none" }, framing: "plate", width: 1, silhouette: true }),
  ],
  // The plate is the adaptive icon's background layer, a color (`colors.json`).
  [
    "adaptive-foreground.png",
    png({
      size: SOURCE,
      plate: { kind: "none" },
      framing: "plate",
      width: ADAPTIVE_WIDTH,
      ground: iconArt.plate,
    }),
  ],
  [
    "adaptive-monochrome.png",
    png({
      size: SOURCE,
      plate: { kind: "none" },
      framing: "whole",
      width: MONOCHROME_WIDTH,
      silhouette: true,
    }),
  ],
  [
    "notification.png",
    png({
      size: NOTIFICATION_SIZE,
      plate: { kind: "none" },
      framing: "whole",
      width: NOTIFICATION_WIDTH,
      silhouette: true,
    }),
  ],
  // The Pip whole on each theme's canvas, in that theme's palette.
  ...(["light", "dark"] as const).map(
    (theme) =>
      [
        `splash-${theme}.png`,
        png({
          size: SOURCE,
          plate: { kind: "none" },
          framing: "whole",
          width: SPLASH_WIDTH,
          theme,
          ground: colors.background[theme],
        }),
      ] as const,
  ),
  // Colors as native configurations take them: the canvas, for the splash
  // screen's background; the accent, for what the system draws in the app's
  // own color (a dialog's buttons, a text cursor); the icon's plate, for the
  // adaptive icon's background; and the icon's Pip, which tints a
  // notification's icon, as the launcher shows it.
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
          iconPlate: iconArt.plate,
          iconPip: hexColor(botPalette[iconArt.avatar.color][iconArt.palette]),
        },
        null,
        2,
      )}\n`;
    },
  ],
];
