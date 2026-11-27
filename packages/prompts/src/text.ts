// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Making text safe to place inside a wake envelope or a bot's instructions.
 *
 * Every tag J3 Bots writes uses a name from {@link EnvelopeTag}, or `data-`
 * followed by the wake's nonce. Any text placed between those tags, from any
 * source, goes through {@link defuseTags}, so it cannot open, close or imitate
 * one of them. The nonce is a second, independent guard for untrusted blocks.
 *
 * Detection runs on a folded copy of the text, so look-alikes count as the real
 * thing: compatibility forms (fullwidth `＜`, small `﹤`), invisible characters
 * inserted between letters, combining marks, case, and the common Cyrillic and
 * Greek letters that pass for Latin ones.
 */

/** Every element name an envelope can contain, apart from the nonce-tagged `data-` blocks. */
export type EnvelopeTag =
  | "j3-wake"
  | "since-last-turn"
  | "message"
  | "attachment"
  | "answer"
  | "question"
  | "chosen"
  | "instruction"
  | "room"
  | "member"
  | "routine"
  | "recent-runs"
  | "run"
  | "step"
  | "earlier-step"
  | "next"
  | "field"
  | "browser-tab"
  | "secret"
  | "server";

const ENVELOPE_TAGS: ReadonlyArray<EnvelopeTag> = [
  "j3-wake",
  "since-last-turn",
  "message",
  "attachment",
  "answer",
  "question",
  "chosen",
  "instruction",
  "room",
  "member",
  "routine",
  "recent-runs",
  "run",
  "step",
  "earlier-step",
  "next",
  "field",
  "browser-tab",
  "secret",
  "server",
];

/** Characters that pass for one of the ASCII characters a tag is made of. */
const LOOK_ALIKES: ReadonlyMap<string, string> = new Map(
  Object.entries({
    "<": "‹˂ᐸ〈⟨❬❮⧼〈≺",
    "/": "∕⁄⧸╱᜵〳",
    "-": "‐‑‒–—―−˗",
    "3": "зӡʒ",
    a: "аɑα",
    c: "сϲ",
    d: "ԁ",
    e: "еε",
    g: "ɡ",
    h: "һн",
    i: "іıιӏ",
    j: "ј",
    k: "кκ",
    l: "ℓ",
    m: "м",
    n: "п",
    o: "оο",
    p: "рρ",
    q: "ԛ",
    s: "ѕ",
    t: "тτ",
    u: "υ",
    v: "ν",
    w: "ԝ",
    x: "хχ",
    y: "у",
  }).flatMap(([ascii, alikes]) => Array.from(alikes, (alike) => [alike, ascii] as const)),
);

const INVISIBLE = /[\p{M}\p{Default_Ignorable_Code_Point}]/gu;

/** The folded form of one code point: possibly empty, possibly several characters. */
const foldCodePoint = (codePoint: string): string =>
  codePoint < "\u0080"
    ? codePoint.toLowerCase()
    : codePoint
        .normalize("NFKD")
        .toLowerCase()
        .normalize("NFKD")
        .replace(INVISIBLE, "")
        .replace(/./gu, (char) => LOOK_ALIKES.get(char) ?? char);

interface Folded {
  readonly codePoints: ReadonlyArray<string>;
  readonly text: string;
  /** For each UTF-16 unit of `text`, the index in `codePoints` it came from. */
  readonly origin: ReadonlyArray<number>;
}

const fold = (text: string): Folded => {
  const codePoints = Array.from(text);
  const origin: Array<number> = [];
  let folded = "";
  codePoints.forEach((codePoint, index) => {
    const part = foldCodePoint(codePoint);
    folded += part;
    for (let unit = 0; unit < part.length; unit++) origin.push(index);
  });
  return { codePoints, text: folded, origin };
};

/** Folds text the way tag detection sees it. */
export const foldForMatching = (text: string): string => fold(text).text;

const TAG_START = new RegExp(
  String.raw`<\s*\/?\s*(?:${ENVELOPE_TAGS.join("|")}|data(?:-[\w-]*)?|j3(?:-[\w-]*)?)(?=[\s/>]|$)`,
  "g",
);

/**
 * Replaces the opening bracket of anything that reads as an envelope tag, or
 * would once look-alikes are folded, with `&lt;`. Text that only resembles HTML
 * or code (`<div>`, `a < b`) is left as written.
 */
export const defuseTags = (text: string): string => {
  const folded = fold(text);
  const defused = new Set<number>();
  for (const match of folded.text.matchAll(TAG_START)) {
    const origin = folded.origin[match.index];
    if (origin !== undefined) defused.add(origin);
  }
  if (defused.size === 0) return text;
  return folded.codePoints
    .map((codePoint, index) => (defused.has(index) ? "&lt;" : codePoint))
    .join("");
};

const ATTRIBUTE_ENTITIES: ReadonlyMap<string, string> = new Map([
  ["&", "&amp;"],
  ['"', "&quot;"],
  ["<", "&lt;"],
  [">", "&gt;"],
]);

const LINE_OR_CONTROL = /[\p{Cc}\p{Zl}\p{Zp}]/u;

/**
 * Makes text safe as a double-quoted attribute value: one line, and no
 * character, or look-alike of one, that could end the value or start a tag.
 */
export const escapeAttribute = (value: string): string =>
  Array.from(value, (codePoint) => {
    if (LINE_OR_CONTROL.test(codePoint)) return " ";
    const folded = foldCodePoint(codePoint);
    const special = Array.from(folded).some((char) => ATTRIBUTE_ENTITIES.has(char));
    return special
      ? Array.from(folded, (char) => ATTRIBUTE_ENTITIES.get(char) ?? char).join("")
      : codePoint;
  }).join("");
