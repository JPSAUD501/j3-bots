// SPDX-License-Identifier: AGPL-3.0-or-later
import type * as DateTime from "effect/DateTime";
import * as Stream from "effect/Stream";
import { Zip, ZipDeflate } from "fflate";

/**
 * The times a zip can hold: from 1980 to the end of 2107, in its DOS format,
 * of which fflate takes up to 2099. A machine whose clock was never set, as a
 * Raspberry Pi can start, still makes its zip, its files dated 1980.
 */
const EARLIEST = Date.UTC(1980, 0, 1, 12);
const LATEST = Date.UTC(2099, 11, 31);

/** One file of a zip: its name in the zip and its text, UTF-8. */
export interface ZipEntry {
  readonly name: string;
  readonly text: string;
}

/**
 * The zip of `entries`, as its bytes are made: each file is compressed and
 * sent on as it comes, so only one file's text and its compressed bytes are
 * held at a time, never the whole zip. Every file carries `at` as its time,
 * within the times a zip can hold.
 * fflate's `ZipDeflate` compresses synchronously, so each file's bytes are
 * all out once it is pushed.
 */
export const zipStream = <E, R>(
  entries: Stream.Stream<ZipEntry, E, R>,
  at: DateTime.Utc,
): Stream.Stream<Uint8Array, E, R> =>
  Stream.suspend(() => {
    const made: Array<Uint8Array> = [];
    const zip = new Zip((error, chunk) => {
      if (error !== null) throw error;
      made.push(chunk);
    });
    const taken = () => made.splice(0, made.length);
    return entries.pipe(
      Stream.flatMap((entry) => {
        const file = new ZipDeflate(entry.name, { level: 6 });
        file.mtime = Math.min(Math.max(at.epochMilliseconds, EARLIEST), LATEST);
        zip.add(file);
        file.push(new TextEncoder().encode(entry.text), true);
        return Stream.fromIterable(taken());
      }),
      Stream.concat(
        Stream.suspend(() => {
          zip.end();
          return Stream.fromIterable(taken());
        }),
      ),
    );
  });
