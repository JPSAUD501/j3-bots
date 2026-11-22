// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Avatar, AvatarChoice } from "@j3-bots/contracts";
import { avatarShapeNames, botHues } from "@j3-bots/design-tokens/names";

/** `items` over and over. */
function* cycle<T>(items: readonly [T, ...T[]]): Generator<T, never> {
  for (;;) yield* items;
}

/**
 * The avatar the server gives a bot created without one: the first of the
 * least used, walking the shapes and the hues (`docs/design/design-language.md`,
 * Bot palette) in step. Ten shapes and nine hues share no factor, so the walk
 * meets every pair once, and any two of the first nine bots differ in both
 * shape and color. Gray stays the operator's to choose: it is also what a
 * client draws for a color it does not know.
 */
export const freeAvatar = (taken: ReadonlyArray<Avatar>): AvatarChoice => {
  const uses = new Map<string, number>();
  for (const { shape, color } of taken) {
    const key = `${shape}/${color}`;
    uses.set(key, (uses.get(key) ?? 0) + 1);
  }
  const usesOf = ({ shape, color }: AvatarChoice) => uses.get(`${shape}/${color}`) ?? 0;
  const shapes = cycle(avatarShapeNames);
  const hues = cycle(botHues);
  const next = (): AvatarChoice => ({ shape: shapes.next().value, color: hues.next().value });
  let best = next();
  for (let pair = 1; pair < avatarShapeNames.length * botHues.length; pair++) {
    const avatar = next();
    if (usesOf(avatar) < usesOf(best)) best = avatar;
  }
  return best;
};
