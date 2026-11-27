// SPDX-License-Identifier: AGPL-3.0-or-later
import type { LookingAt } from "@j3-bots/contracts";
import {
  MAX_PICTURE_SIDE,
  type PictureReach,
  type QuickAccessPicture,
  type ScreenAccess,
} from "@j3-bots/desktop-bridge";
import type * as Duration from "effect/Duration";
import type * as Effect from "effect/Effect";
import type { NativeImage } from "electron";

/** The window that was in front, as one system's reader read it. */
export interface FrontWindow {
  readonly lookingAt: LookingAt;
  /** Whether a picture of it can be taken now. */
  readonly picture: PictureReach;
  /** A picture of it as it is now: taken only when this runs. */
  readonly takePicture: Effect.Effect<QuickAccessPicture>;
}

/**
 * How the app reads the window in front on one system. Nothing is read
 * until `front` runs, which the global shortcut alone does.
 */
export interface WindowReader {
  /** `none` where no app may read another's window (Wayland). */
  readonly reach: "window" | "none";
  /**
   * How long quick access may wait for `front` before it takes focus: a
   * reader that asks the system which window has it must ask first.
   */
  readonly beforeFocus: Duration.Duration;
  /**
   * The window in front, its title read only `withTitle`; `null` when it
   * is the app's own, or nothing could be read.
   */
  readonly front: (options: { readonly withTitle: boolean }) => Effect.Effect<FrontWindow | null>;
  readonly screen: Effect.Effect<ScreenAccess>;
  /** Asks the system for what `screen` says is `needed`, where the operator gives it. */
  readonly askScreenAccess: Effect.Effect<void>;
}

/** JPEG quality of a picture of a window: text in it stays legible, and it stays small. */
const QUALITY = 82;

/**
 * `image` as quick access sends it: a JPEG at most `MAX_PICTURE_SIDE` on its
 * longest side; `failed` for an empty image.
 */
export const pictureOf = (image: NativeImage): QuickAccessPicture => {
  const { width, height } = image.getSize();
  if (width < 1 || height < 1) return { _tag: "failed" };
  const scale = Math.min(1, MAX_PICTURE_SIDE / Math.max(width, height));
  const fitted =
    scale === 1
      ? image
      : image.resize({
          width: Math.max(1, Math.round(width * scale)),
          height: Math.max(1, Math.round(height * scale)),
          quality: "good",
        });
  const size = fitted.getSize();
  if (size.width < 1 || size.height < 1) return { _tag: "failed" };
  return {
    _tag: "taken",
    bytes: new Uint8Array(fitted.toJPEG(QUALITY)),
    mediaType: "image/jpeg",
    width: Math.min(size.width, MAX_PICTURE_SIDE),
    height: Math.min(size.height, MAX_PICTURE_SIDE),
  };
};
