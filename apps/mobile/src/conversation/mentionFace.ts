// SPDX-License-Identifier: AGPL-3.0-or-later
import { avatarSeed, createAvatar, stillFace } from "@j3-bots/client-runtime/presentation";
import type { Avatar, BotId } from "@j3-bots/contracts";
import { resolveAvatar, type Themed } from "@j3-bots/design-tokens";
import { renderStillAvatar } from "@j3-bots/design-tokens/raster";
import * as Base64 from "effect/encoding/Base64";

const drawn = new Map<string, string>();

/**
 * A bot's still face as the composer's native field draws it in a mention: a
 * PNG in base64, `px` px on a screen of `scale` pixels per px, in `theme`'s
 * colors, the same face a message's mention shows. Each is drawn once.
 */
export function mentionFace(
  avatar: Avatar,
  botId: BotId,
  theme: keyof Themed,
  px: number,
  scale: number,
): string {
  const { shape, color } = resolveAvatar(avatar);
  const size = Math.max(1, Math.round(px * scale));
  const key = `${botId}:${shape}:${color}:${theme}:${px}:${size}`;
  const known = drawn.get(key);
  if (known !== undefined) return known;
  const face = stillFace("idle", createAvatar(avatarSeed(botId), "idle").traits);
  const png = Base64.encode(renderStillAvatar({ shape, color }, face, theme, size, px));
  drawn.set(key, png);
  return png;
}
