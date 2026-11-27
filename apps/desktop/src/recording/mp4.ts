// SPDX-License-Identifier: AGPL-3.0-or-later
import * as Effect from "effect/Effect";

// A screen's video is a fragmented MP4, written as the encoder hands out
// each fragment: its header boxes (`ftyp`, `moov`), then one `moof` and its
// `mdat` per fragment. A recording the app did not finish may end inside a
// box; cut there, the file keeps every whole fragment and plays to its end.

const decoder = new TextDecoder("latin1");

/**
 * How much of a fragmented MP4 of `size` bytes holds whole boxes, ending
 * after its header or after a fragment's media: what to keep of it. 0 when
 * not even its header is whole. `read(offset, length)` gives up to `length`
 * bytes at `offset`.
 */
export const wholeFragments = Effect.fn("recording.wholeFragments")(function* <E, R>(
  size: number,
  read: (offset: number, length: number) => Effect.Effect<Uint8Array, E, R>,
) {
  let at = 0;
  let keep = 0;
  let header = false;
  while (at + 8 <= size) {
    const head = yield* read(at, 16);
    if (head.length < 8) break;
    const view = new DataView(head.buffer, head.byteOffset, head.byteLength);
    const small = view.getUint32(0);
    const type = decoder.decode(head.subarray(4, 8));
    let length = small;
    if (small === 1) {
      if (head.length < 16) break;
      length = Number(view.getBigUint64(8));
    }
    // 0 runs to the end of the file, which a writer that stopped cannot vouch for.
    if (length < 8 || at + length > size) break;
    at += length;
    if (type === "moov") header = true;
    if (header && (type === "moov" || type === "mdat")) keep = at;
  }
  return keep;
});

/** How much of `events.jsonl` holds whole lines. */
export const wholeLines = (bytes: Uint8Array): number => bytes.lastIndexOf(0x0a) + 1;
