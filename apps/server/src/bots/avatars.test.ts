// SPDX-License-Identifier: AGPL-3.0-or-later
import { assert, it } from "@effect/vitest";
import type { Avatar } from "@j3-bots/contracts";
import { freeAvatar } from "./avatars.ts";

it("gives the first nine bots nine shapes and nine colors, none of them gray", () => {
  const taken: Array<Avatar> = [];
  for (let bot = 0; bot < 9; bot++) taken.push(freeAvatar(taken));
  assert.strictEqual(new Set(taken.map(({ shape }) => shape)).size, 9);
  assert.strictEqual(new Set(taken.map(({ color }) => color)).size, 9);
  assert.notInclude(
    taken.map(({ color }) => color),
    "gray",
  );
});
