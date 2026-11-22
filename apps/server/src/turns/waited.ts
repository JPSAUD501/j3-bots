// SPDX-License-Identifier: AGPL-3.0-or-later
import * as DateTime from "effect/DateTime";

/** A stretch a turn waited on the operator: a card from its arrival until it closed. */
export interface WaitSpan {
  readonly from: DateTime.Utc;
  /** Null while the card is still open. */
  readonly until: DateTime.Utc | null;
}

/**
 * How many milliseconds of `from`–`to` the turn spent waiting on the
 * operator. A card still open waits until `to`, and two cards open at once
 * count their shared time once, so the result never exceeds the span.
 */
export const waitedWithin = (
  spans: ReadonlyArray<WaitSpan>,
  from: DateTime.Utc,
  to: DateTime.Utc,
): number => {
  const start = DateTime.toEpochMillis(from);
  const end = DateTime.toEpochMillis(to);
  const clipped = spans
    .map((span) => ({
      a: Math.max(DateTime.toEpochMillis(span.from), start),
      b: Math.min(span.until === null ? end : DateTime.toEpochMillis(span.until), end),
    }))
    .filter(({ a, b }) => a < b)
    .toSorted((x, y) => x.a - y.a);
  let waited = 0;
  let reached = start;
  for (const { a, b } of clipped) {
    if (b <= reached) continue;
    waited += b - Math.max(a, reached);
    reached = b;
  }
  return waited;
};
