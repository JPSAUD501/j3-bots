// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * A bot's pointer over a page it browses, the same on every platform: a
 * rounded arrow in the bot's color, and beside it a tag with the bot's face
 * and name. Its colors are not the theme's: a pointer is drawn over a web
 * page, which keeps its own colors whatever the app's theme, so it is white
 * edged and reads on any page, as a system pointer does.
 */
export const pointer = {
  /** The arrow, in a 32-unit box, rounded at every corner. */
  arrow:
    "M5 4.2C5 3.3 6 2.9 6.7 3.5L21.3 17.2C22 17.8 21.6 18.9 20.7 19L12.6 19.6C12 19.6 11.5 19.9 11.2 20.4L7 26.3C6.5 27.1 5 26.7 5 25.8Z",
  /** The arrow's box, in units and in px: it is drawn at one px a unit. */
  box: 32,
  /** The point the arrow points with, in the box: where the bot points on the page. */
  tip: { x: 5, y: 3 },
  /** The arrow's white edge, in units. */
  outline: 2,
  /** The arrow's edge and the tag's ground. */
  light: "#ffffff",
  /** The tag's name. */
  ink: "#1a1a1a",
  /** The soft shadow under the arrow, as a CSS `drop-shadow()` and Android's `filter` take it. */
  arrowShadow: "drop-shadow(0px 1.5px 2px rgba(0, 0, 0, 0.28))",
  /** The shadow under the tag, in `rgba()` with units on every length, as Android's `boxShadow` takes it. */
  tagShadow: "0px 2px 5px 0px rgba(0, 0, 0, 0.2)",
  /** Where the tag's corner is from the point, in px: below the arrow and to its right. */
  tagAt: { x: 18, y: 24 },
  /** The tag's height and its edge in the bot's color, in px. */
  tagHeight: 22,
  tagEdge: 1.5,
  /** The face on the tag, in px. */
  face: 16,
  /** The tag grows from this scale as it opens. */
  tagFrom: 0.7,
  /** How long the tag stays once the pointer arrives, in ms. */
  tagLinger: 500,
  /** How long a click's answer lasts, the bot's face smiling, in ms; the tag stays this long and then `tagLinger`. */
  clickAnswer: 900,
  /** How long the face is surprised once the person takes the tab, before it waits, in ms. */
  surprise: 700,
  /** How long the ring of a click spreads and fades, in ms. */
  ring: 450,
  /** A click squashes the arrow to this scale, from its point, and it springs back on `pop`. */
  pressScale: 0.82,
  /** A click's ring spreads to this scale, over a soft disc of the bot's color at `bloomOpacity`. */
  ringTo: 1.7,
  bloomOpacity: 0.28,
  /** While the person holds the tab, the pointer moves this far aside, in px, to where the page has room, and fades to `heldOpacity`. */
  aside: { x: 80, y: 36 },
  heldOpacity: 0.4,
  /**
   * How a move travels, in page px and seconds (docs/design/design-language.md#motion).
   * Its progress along its path rides a spring of this damping, answering in
   * `response.shortest` for the shortest move and `response.longest` for one across
   * half the page's diagonal or more.
   */
  progressDamping: 0.92,
  response: { shortest: 0.45, longest: 0.85 },
  /** The drawn tip follows the path through a soft filter: a spring answering in `response` s. */
  follow: { response: 0.16, damping: 0.8 },
  /**
   * The arrow leans into a move, turning on its tip: at most `most` degrees, upright
   * under `from` px/s, fully leant from `full` px/s, on a spring answering in `response` s.
   */
  lean: { most: 24, from: 40, full: 650, response: 0.3, damping: 0.85 },
  /** The way the arrow points at rest, in degrees from the page's x axis: up and to the left. */
  axis: -135,
  /** A pointer new to the page comes in from this far below and to the right of its point, in px, answering in `arriveResponse` s. */
  arriveFrom: { x: 26, y: 30 },
  arriveResponse: 0.5,
  /** Its move aside answers in this many seconds. */
  asideResponse: 0.5,
  /** Thinking before it acts, the tip drifts in a figure eight this many px wide each way, once in `period` ms, easing in and out over `ease` ms. */
  drift: { size: 2.4, period: 2400, ease: 400 },
  /** The tag keeps this far from the page's edges, in px. */
  tagMargin: 6,
  /** A tag flipped to the left of the point or above it sits this far from it, in px. */
  tagGap: 8,
} as const;
