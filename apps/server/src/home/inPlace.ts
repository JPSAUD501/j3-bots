// SPDX-License-Identifier: AGPL-3.0-or-later
// @effect-diagnostics nodeBuiltinImport:off -- Opening a file so that a link at its name is refused takes O_NOFOLLOW, which Effect's FileSystem cannot pass.
import * as NodeFs from "node:fs";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

/**
 * A write in place that did not happen: `file` could not be opened or
 * written (`code`, as Node gives it: `ELOOP` for a link at its name).
 */
export class InPlaceFailure extends Schema.TaggedError<InPlaceFailure>()("InPlaceFailure", {
  file: Schema.String,
  code: Schema.NullOr(Schema.String),
}) {}

const failure = (file: string, cause: NodeJS.ErrnoException) =>
  new InPlaceFailure({ file, code: cause.code ?? null });

const openFile = (file: string, flags: number) =>
  Effect.callback<number, InPlaceFailure>((resume) => {
    NodeFs.open(file, flags, 0o600, (error, fd) => {
      resume(error === null ? Effect.succeed(fd) : Effect.fail(failure(file, error)));
    });
  });

const closeFile = (fd: number) =>
  Effect.callback<void>((resume) => {
    NodeFs.close(fd, () => resume(Effect.void));
  });

/** Writes the whole of `chunk` to `fd`, however many writes that takes. */
const writeAll = (file: string, fd: number, chunk: Uint8Array) =>
  Effect.callback<void, InPlaceFailure>((resume) => {
    const from = (offset: number) => {
      if (offset >= chunk.byteLength) return resume(Effect.void);
      NodeFs.write(fd, chunk, offset, chunk.byteLength - offset, null, (error, written) => {
        if (error === null) from(offset + written);
        else resume(Effect.fail(failure(file, error)));
      });
    };
    from(0);
  });

/**
 * Writes `bytes` into `file` in place, after what it holds when `append`,
 * creating it (mode 0600) when missing: for a download or an upload that
 * resumes. The
 * caller checks `file`'s folder first (`Layout.writable`); a link at `file`
 * is refused, even one put there after that check, except on Windows, which
 * has no such open and follows it.
 */
export const writeInPlace = <E>(
  file: string,
  append: boolean,
  bytes: Stream.Stream<Uint8Array, E>,
): Effect.Effect<void, InPlaceFailure | E> =>
  Effect.gen(function* () {
    const { O_WRONLY, O_CREAT, O_NOFOLLOW, O_APPEND, O_TRUNC } = NodeFs.constants;
    const fd = yield* Effect.acquireRelease(
      openFile(file, O_WRONLY | O_CREAT | (O_NOFOLLOW ?? 0) | (append ? O_APPEND : O_TRUNC)),
      closeFile,
    );
    // Interrupting a write leaves Node's `fs.write` running: closing the
    // descriptor under it could let it land in whatever file reuses the
    // number. So each chunk finishes first; the stream stays interruptible
    // between chunks.
    yield* Stream.runForEach(bytes, (chunk) => Effect.uninterruptible(writeAll(file, fd, chunk)));
  }).pipe(Effect.scoped);
