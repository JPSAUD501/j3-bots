// SPDX-License-Identifier: AGPL-3.0-or-later
import { assert, it } from "@effect/vitest";
import type { Avatar } from "@j3-bots/contracts";
import { avatarShapeNames, botColors, resolveAvatar } from "@j3-bots/design-tokens";
import { freeAvatar } from "./avatars.ts";

it("gives every new bot an avatar the clients draw in its own color", () => {
  const taken: Array<Avatar> = [];
  // Past every shape and color, so the least used ones come round again.
  for (let bot = 0; bot <= avatarShapeNames.length * botColors.length; bot++) {
    const avatar = freeAvatar(taken);
    assert.deepStrictEqual(resolveAvatar(avatar), avatar);
    assert.notStrictEqual(avatar.color, "gray");
    taken.push(avatar);
  }
});
