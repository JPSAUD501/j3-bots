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
 * The avatars the server gives new bots, in order: each next bot takes the
 * first pair whose shape and color are least used. Twelve shapes and twelve
 * colors, each once, ordered so the first few sit well side by side: neighbors
 * differ in hue, in lightness and in outline.
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

/**
 * The avatar a new bot takes when nobody chose one: the first pair of the
 * cast whose shape and color the bots in `taken` use least. The cast names
 * every shape and every color once, so the first twelve bots differ in both,
 * and a shape or a color the operator chose for one bot is passed over for
 * the next. The server gives it to a bot created without an avatar, and a
 * picker offers it first, so what the operator sees is what they get.
 */
export function freeAvatar(
  taken: ReadonlyArray<{ readonly shape: string; readonly color: string }>,
): AvatarPair {
  const uses = new Map<string, number>();
  const count = (key: string) => uses.set(key, (uses.get(key) ?? 0) + 1);
  for (const { shape, color } of taken) {
    count(`shape/${shape}`);
    count(`color/${color}`);
  }
  const usesOf = ({ shape, color }: AvatarPair) =>
    (uses.get(`shape/${shape}`) ?? 0) + (uses.get(`color/${color}`) ?? 0);
  const [first, ...rest] = avatarCast;
  if (first === undefined) throw new Error("The avatar cast is empty.");
  return rest.reduce((best, pair) => (usesOf(pair) < usesOf(best) ? pair : best), first);
}
