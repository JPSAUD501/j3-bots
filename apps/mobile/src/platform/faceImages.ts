// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  type AvatarState,
  avatarSeed,
  createAvatar,
  stillFace,
} from "@j3-bots/client-runtime/presentation";
import type { Avatar, BotId } from "@j3-bots/contracts";
import { resolveAvatar, type Themed } from "@j3-bots/design-tokens";
import {
  Canvas,
  drawAvatar,
  parseColor,
  renderStillAvatar,
  toSrgb8,
} from "@j3-bots/design-tokens/raster";
import * as Base64 from "effect/encoding/Base64";

// A bot's still face as a PNG in base64, for what Android draws itself and
// takes only as an image: a widget, a Direct Share shortcut. Each is drawn
// once per look, state, theme and size, as the composer's mention faces are.

const drawn = new Map<string, string>();

const once = (key: string, draw: () => Uint8Array<ArrayBuffer>): string => {
  const known = drawn.get(key);
  if (known !== undefined) return known;
  const png = Base64.encode(draw());
  drawn.set(key, png);
  return png;
};

const faceOf = (botId: BotId, state: AvatarState) =>
  stillFace(state, createAvatar(avatarSeed(botId), state).traits);

/** The face of a bot in `state`, `size` px square on a clear background, in `theme`'s colors. */
export function stateFace(
  avatar: Avatar,
  botId: BotId,
  state: AvatarState,
  theme: keyof Themed,
  size: number,
): string {
  const { shape, color } = resolveAvatar(avatar);
  return once(`state:${botId}:${shape}:${color}:${state}:${theme}:${size}`, () =>
    renderStillAvatar({ shape, color }, faceOf(botId, state), theme, size),
  );
}

/** Where an adaptive icon's mask may cut: the face keeps to the middle of its 108 dp. */
const ICON_FACE = 0.58;

/**
 * A bot's face at rest as an adaptive icon, `size` px square and full bleed:
 * on `plate`, the light muted color of the theme shown, which the launcher's
 * mask shapes, with the face inside the part no mask cuts.
 */
export function iconFace(avatar: Avatar, botId: BotId, plate: string, size: number): string {
  const { shape, color } = resolveAvatar(avatar);
  return once(`icon:${botId}:${shape}:${color}:${plate}:${size}`, () => {
    const canvas = new Canvas(size, size, toSrgb8(parseColor(plate)));
    const side = Math.round(size * ICON_FACE);
    const at = Math.round((size - side) / 2);
    drawAvatar(canvas, { shape, color }, faceOf(botId, "idle"), "light", {
      x: at,
      y: at,
      size: side,
    });
    return canvas.png();
  });
}
