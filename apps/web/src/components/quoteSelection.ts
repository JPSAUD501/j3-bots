// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Where a selection of a message's text stands in the text as written
 * (decision 0094), which the server checks a passage against word for word.
 *
 * `MessageText` marks what it draws: its root with the message's id
 * (`data-quote-text`); each piece that shows the text as written, from where
 * it starts (`data-at`: plain text, code and a link); and each mention, which
 * stands for `@` and a name from `data-atom-at` to `data-atom-end`. A boundary
 * inside a mention goes to its edge, so the mention is quoted whole. Files
 * show none of the text, and a boundary in one, or between pieces, goes to
 * the nearest piece's edge on the selection's side.
 */

/** The attribute on a message's text that names the message. */
const QUOTE_TEXT = "data-quote-text";

/** A passage of one message's text: its id, and where the passage starts and ends. */
export interface SelectedPassage {
  readonly messageId: string;
  readonly start: number;
  readonly end: number;
}

type Side = "start" | "end";

const elementOf = (node: Node): Element | null =>
  node instanceof Element ? node : node.parentElement;

const textRootOf = (node: Node): HTMLElement | null =>
  elementOf(node)?.closest<HTMLElement>(`[${QUOTE_TEXT}]`) ?? null;

const numberIn = (element: Element, name: string): number | null => {
  const value = Number(element.getAttribute(name) ?? Number.NaN);
  return Number.isInteger(value) && value >= 0 ? value : null;
};

/** Where a piece or a mention starts and ends in the text; null for what is neither. */
function spanOf(element: Element): readonly [number, number] | null {
  const at = numberIn(element, "data-at");
  if (at !== null) return [at, at + (element.textContent ?? "").length];
  const atomAt = numberIn(element, "data-atom-at");
  const atomEnd = numberIn(element, "data-atom-end");
  return atomAt !== null && atomEnd !== null && atomEnd >= atomAt ? [atomAt, atomEnd] : null;
}

const PIECES = "[data-at],[data-atom-at]";

/** Where the point `(node, offset)` inside `root` stands in the message's text. */
function offsetAt(root: HTMLElement, node: Node, offset: number, side: Side): number | null {
  const owner = elementOf(node)?.closest(PIECES) ?? null;
  if (owner !== null && root.contains(owner)) {
    const span = spanOf(owner);
    if (span !== null) {
      if (owner.hasAttribute("data-at")) {
        const before = root.ownerDocument.createRange();
        before.setStart(owner, 0);
        before.setEnd(node, offset);
        return span[0] + before.toString().length;
      }
      return side === "start" ? span[0] : span[1];
    }
  }
  // Between pieces, or in a file: the edge of the nearest piece on the selection's side.
  const point = root.ownerDocument.createRange();
  point.setStart(node, offset);
  point.collapse(true);
  const pieces = [...root.querySelectorAll(PIECES)];
  if (side === "start") {
    for (const piece of pieces) {
      const span = spanOf(piece);
      if (span !== null && point.comparePoint(piece, 0) >= 0) return span[0];
    }
    return null;
  }
  for (const piece of pieces.toReversed()) {
    const span = spanOf(piece);
    if (span !== null && point.comparePoint(piece, piece.childNodes.length) <= 0) return span[1];
  }
  return null;
}

/**
 * Whether `range` ends past `root` with nothing more selected than space, as
 * a triple click on a message's last paragraph does, which ends where what
 * follows the text starts.
 */
function endsJustPast(root: HTMLElement, range: Range): boolean {
  if (root.contains(range.endContainer)) return false;
  const past = root.ownerDocument.createRange();
  past.setStartAfter(root);
  past.setEnd(range.endContainer, range.endOffset);
  return past.toString().trim() === "";
}

/**
 * The passage `range` selects when it lies within one message's text, as
 * `[start, end)` of that text; null when it spans two messages, lies outside
 * a message's text, or selects none of it.
 */
export function selectedPassage(range: Range): SelectedPassage | null {
  const root = textRootOf(range.startContainer);
  if (root === null) return null;
  const toEnd = endsJustPast(root, range);
  if (!toEnd && textRootOf(range.endContainer) !== root) return null;
  const messageId = root.getAttribute(QUOTE_TEXT);
  if (messageId === null) return null;
  const start = offsetAt(root, range.startContainer, range.startOffset, "start");
  const end = toEnd
    ? offsetAt(root, root, root.childNodes.length, "end")
    : offsetAt(root, range.endContainer, range.endOffset, "end");
  if (start === null || end === null || end <= start) return null;
  return { messageId, start, end };
}
