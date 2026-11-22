// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Avatar } from "@j3-bots/contracts";
import { avatarShapeNames, botColors } from "@j3-bots/design-tokens";

/**
 * The colors the server gives a bot created without an avatar: the clients'
 * own palette (`docs/design/design-language.md`, Avatars), so every one is a
 * color they draw. Gray stays the operator's to choose: it is also what a
 * client draws for a color it does not know.
 */
const COLORS = botColors.filter((color) => color !== "gray");

/**
 * The first avatar no bot uses among `shapes` and the palette, colors first so
 * neighbours in a roster differ in color. When every one is taken, the least used.
 */
export const freeAvatar = (
  taken: ReadonlyArray<Avatar>,
  shapes: ReadonlyArray<string> = avatarShapeNames,
): Avatar => {
  const uses = new Map<string, number>();
  for (const { shape, color } of taken) {
    const key = `${shape}/${color}`;
    uses.set(key, (uses.get(key) ?? 0) + 1);
  }
  let best: { readonly avatar: Avatar; readonly uses: number } | undefined;
  for (const shape of shapes) {
    for (const color of COLORS) {
      const count = uses.get(`${shape}/${color}`) ?? 0;
      if (best === undefined || count < best.uses) best = { avatar: { shape, color }, uses: count };
    }
  }
  if (best === undefined) throw new Error("An avatar needs at least one shape to choose from.");
  return best.avatar;
};
