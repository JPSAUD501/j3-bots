// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Avatar } from "@j3-bots/contracts";

/**
 * The avatars the server gives a bot created without one. The values are
 * design tokens the clients render (`docs/design/design-language.md`, Avatars);
 * the avatar system is still being explored, so this palette is provisional.
 */
const SHAPES = ["circle", "square", "hexagon", "triangle", "diamond"] as const;
const COLORS = ["teal", "amber", "violet", "rose", "sky", "lime", "orange", "indigo"] as const;

/**
 * The first avatar of the palette no bot uses, colors first so neighbours in a
 * roster differ in color. When every one is taken, the least used.
 */
export const freeAvatar = (taken: ReadonlyArray<Avatar>): Avatar => {
  const uses = new Map<string, number>();
  for (const { shape, color } of taken) {
    const key = `${shape}/${color}`;
    uses.set(key, (uses.get(key) ?? 0) + 1);
  }
  let best: { readonly avatar: Avatar; readonly uses: number } | undefined;
  for (const shape of SHAPES) {
    for (const color of COLORS) {
      const count = uses.get(`${shape}/${color}`) ?? 0;
      if (best === undefined || count < best.uses) best = { avatar: { shape, color }, uses: count };
    }
  }
  return best?.avatar ?? { shape: SHAPES[0], color: COLORS[0] };
};
