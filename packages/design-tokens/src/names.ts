// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The names of the avatar tokens, apart from how they look, so the contract
 * and the server can name them without loading shapes or colors. The
 * silhouettes (`avatarShapes`) and the palette (`botPalette`) have one entry
 * per name.
 */

/** The avatar silhouettes, in the order a picker lists them. */
export const avatarShapeNames = [
  "dome",
  "block",
  "bean",
  "loaf",
  "drop",
  "ears",
  "horns",
  "ghost",
  "hex",
  "gem",
  "toes",
  "pear",
] as const;

export type AvatarShapeName = (typeof avatarShapeNames)[number];

/**
 * The bot colors, in the order a picker lists them: round the hue circle,
 * then slate, the one quiet color. Slate is also what a client draws for a
 * color it does not know (`resolveAvatar`).
 */
export const botColors = [
  "tomato",
  "tangerine",
  "honey",
  "lime",
  "mint",
  "teal",
  "sky",
  "cobalt",
  "iris",
  "orchid",
  "rose",
  "slate",
] as const;

export type BotColor = (typeof botColors)[number];

/**
 * The avatars the server gives new bots, in order. Twelve shapes and twelve
 * colors, each once, ordered so the first few sit well side by side:
 * neighbors differ in hue, in lightness and in outline.
 */
export const avatarCast: ReadonlyArray<{
  readonly shape: AvatarShapeName;
  readonly color: BotColor;
}> = [
  { shape: "dome", color: "tangerine" },
  { shape: "ears", color: "cobalt" },
  { shape: "drop", color: "mint" },
  { shape: "horns", color: "orchid" },
  { shape: "ghost", color: "honey" },
  { shape: "block", color: "iris" },
  { shape: "toes", color: "tomato" },
  { shape: "bean", color: "sky" },
  { shape: "pear", color: "lime" },
  { shape: "hex", color: "rose" },
  { shape: "loaf", color: "teal" },
  { shape: "gem", color: "slate" },
];

type AvatarPair = (typeof avatarCast)[number];

const castIndex = (key: "shape" | "color", token: string) =>
  avatarCast.findIndex((pair) => pair[key] === token);

/**
 * Every pair of a shape and a color, in the order a new bot is offered them
 * when they are used equally: the cast first, then the rest by the cast's
 * order of their shape, then of their color.
 */
const allPairs: ReadonlyArray<AvatarPair> = [
  ...avatarCast,
  ...avatarCast
    .flatMap(({ shape }) => avatarCast.map(({ color }) => ({ shape, color })))
    .filter(({ shape, color }) => castIndex("shape", shape) !== castIndex("color", color)),
];

/**
 * The avatar a new bot takes when nobody chose one: of every pair, the one
 * the bots in `taken` use least as a pair, then whose shape and color they
 * use least, the first in `allPairs` of those. So the first twelve bots take
 * the cast and differ in both, no two bots share a pair until all 144 are
 * used, and a shape or a color the operator chose for one bot is passed over
 * for the next. The server gives it to a bot created without an avatar, and
 * a picker offers it first, so what the operator sees is what they get.
 */
export function freeAvatar(
  taken: ReadonlyArray<{ readonly shape: string; readonly color: string }>,
): AvatarPair {
  const uses = new Map<string, number>();
  const count = (key: string) => uses.set(key, (uses.get(key) ?? 0) + 1);
  for (const { shape, color } of taken) {
    count(`pair/${shape}/${color}`);
    count(`shape/${shape}`);
    count(`color/${color}`);
  }
  const use = (key: string) => uses.get(key) ?? 0;
  const rank = ({ shape, color }: AvatarPair) =>
    [use(`pair/${shape}/${color}`), use(`shape/${shape}`) + use(`color/${color}`)] as const;
  const [first, ...rest] = allPairs;
  if (first === undefined) throw new Error("The avatar cast is empty.");
  return rest.reduce((best, pair) => {
    const [pairUse, partUse] = rank(pair);
    const [bestPairUse, bestPartUse] = rank(best);
    return pairUse < bestPairUse || (pairUse === bestPairUse && partUse < bestPartUse)
      ? pair
      : best;
  }, first);
}
