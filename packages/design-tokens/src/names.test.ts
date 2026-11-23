// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, it } from "vite-plus/test";
import { avatarCast, freeAvatar } from "./names.ts";

it("gives the first twelve bots twelve shapes and twelve colors", () => {
  const taken: Array<{ shape: string; color: string }> = [];
  for (let bot = 0; bot < 12; bot++) taken.push(freeAvatar(taken));
  expect(new Set(taken.map(({ shape }) => shape)).size).toBe(12);
  expect(new Set(taken.map(({ color }) => color)).size).toBe(12);
});

it("passes over a shape and a color the operator chose for another bot", () => {
  const next = freeAvatar([{ shape: "dome", color: "cobalt" }]);
  expect(next.shape).not.toBe("dome");
  expect(next.color).not.toBe("cobalt");
});

it("gives 24 bots 24 different pairs, the first twelve the cast's", () => {
  const taken: Array<{ shape: string; color: string }> = [];
  for (let bot = 0; bot < 24; bot++) taken.push(freeAvatar(taken));
  expect(taken.slice(0, 12)).toEqual(avatarCast);
  expect(new Set(taken.map(({ shape, color }) => `${shape}/${color}`)).size).toBe(24);
});
