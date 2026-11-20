// SPDX-License-Identifier: AGPL-3.0-or-later
// @effect-diagnostics nodeBuiltinImport:off -- Opening a file so that neither a FIFO blocks the open nor a link at its name is followed takes O_NONBLOCK and O_NOFOLLOW, and checking the opened file takes its descriptor, which Effect's FileSystem cannot pass or give.
import * as NodeFs from "node:fs";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import type * as Scope from "effect/Scope";

// A file a bot names in its workspace, read for attaching (`docs/architecture/server.md`,
// Attachments). Keeping the read inside the workspace is a guardrail against
// a bot attaching the wrong file, not a security boundary: the bot runs
// commands as the same OS user as the server, so it can read any file the
// server can and could copy one in (`docs/architecture/security.md`).
//
// The root is the workspace's real path kept from provisioning, never
// resolved again, so a link the bot puts in its folder's place leads nowhere
// inside it. The path is resolved and checked, and the file opened by the
// resolved path; between the two the bot can swap a folder on the way for a
// link that leads out. So the check that counts is made on the open
// descriptor, after the open: on Linux, where the kernel names the descriptor's
// file at `/proc/self/fd/<fd>`, by that name, which no later swap changes.
// Elsewhere, by matching the descriptor's file to what the path resolves to
// again, with no link on it: a folder swapped out and back between those two
// reads could still pass it, which the guardrail accepts. Node has no
// `openat`, which would open each folder without following a link, nor
// another way to name a descriptor's file.

/** What reading a file the bot named in its workspace found. */
export type WorkspaceRead =
  | { readonly _tag: "read"; readonly name: string; readonly bytes: Uint8Array }
  /** Nothing at that path. */
  | { readonly _tag: "missing" }
  /** The path, or a link on it, leads out of the workspace, or did when the file was opened. */
  | { readonly _tag: "outside" }
  /** A folder, a FIFO, a device or a socket: only a regular file is read. */
  | { readonly _tag: "not-a-file" }
  /** More bytes than the limit: reading stopped past it. */
  | { readonly _tag: "too-large" }
  | { readonly _tag: "unreadable" };

/** How much is read from the descriptor at a time. */
const CHUNK_BYTES = 64 * 1024;

const openFile = (file: string, flags: number) =>
  Effect.callback<number, NodeJS.ErrnoException>((resume) => {
    NodeFs.open(file, flags, (error, fd) => {
      resume(error === null ? Effect.succeed(fd) : Effect.fail(error));
    });
  });

const closeFile = (fd: number) =>
  Effect.callback<void>((resume) => {
    NodeFs.close(fd, () => resume(Effect.void));
  });

const fstat = (fd: number) =>
  Effect.callback<NodeFs.Stats, NodeJS.ErrnoException>((resume) => {
    NodeFs.fstat(fd, (error, stats) => {
      resume(error === null ? Effect.succeed(stats) : Effect.fail(error));
    });
  });

const stat = (file: string) =>
  Effect.callback<NodeFs.Stats, NodeJS.ErrnoException>((resume) => {
    NodeFs.stat(file, (error, stats) => {
      resume(error === null ? Effect.succeed(stats) : Effect.fail(error));
    });
  });

/**
 * Reads `fd` from its start into `buffer`, at `offset`. Uninterruptible:
 * closing the descriptor under a read Node still runs could let it read
 * whatever file reuses the number.
 */
const readInto = (fd: number, buffer: Uint8Array, offset: number) =>
  Effect.uninterruptible(
    Effect.callback<number, NodeJS.ErrnoException>((resume) => {
      NodeFs.read(fd, buffer, offset, buffer.byteLength - offset, offset, (error, read) => {
        resume(error === null ? Effect.succeed(read) : Effect.fail(error));
      });
    }),
  );

/** The bytes of `fd`, or none when there are more than `limit`: it reads at most `limit + 1`. */
const readBounded = Effect.fnUntraced(function* (fd: number, limit: number) {
  let buffer = new Uint8Array(Math.min(CHUNK_BYTES, limit + 1));
  let length = 0;
  while (true) {
    if (length === buffer.byteLength) {
      if (length > limit) return undefined;
      const grown = new Uint8Array(Math.min(buffer.byteLength * 2, limit + 1));
      grown.set(buffer);
      buffer = grown;
    }
    const read = yield* readInto(fd, buffer, length);
    if (read === 0) return buffer.subarray(0, length);
    length += read;
  }
});

/** Reads a file a bot names in its workspace: see `workspaceReader`. */
type ReadWorkspaceFile = (
  root: string,
  given: string,
  limit: number,
) => Effect.Effect<WorkspaceRead>;

/**
 * Reads the file `given` names, relative to the workspace whose real path,
 * kept from provisioning, is `root`, at most `limit` bytes of it. A link
 * inside the workspace that leads to a file inside it is followed.
 */
export const workspaceReader = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const read: ReadWorkspaceFile = Effect.fn("readWorkspaceFile")(function* (
    root: string,
    given: string,
    limit: number,
  ): Effect.fn.Return<WorkspaceRead, never, Scope.Scope> {
    const isInside = (location: string) => {
      const relative = path.relative(root, location);
      return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
    };

    const resolved = yield* fs.realPath(path.resolve(root, given)).pipe(Effect.option);
    if (Option.isNone(resolved)) return { _tag: "missing" };
    const real = resolved.value;
    if (!isInside(real)) return { _tag: "outside" };

    const { O_RDONLY, O_NONBLOCK, O_NOFOLLOW } = NodeFs.constants;
    const opened = yield* Effect.acquireRelease(
      openFile(real, O_RDONLY | O_NONBLOCK | O_NOFOLLOW).pipe(Effect.result),
      (result) => (Result.isSuccess(result) ? closeFile(result.success) : Effect.void),
    );
    if (Result.isFailure(opened)) {
      const { code } = opened.failure;
      // ELOOP: a link was put at the name after it was resolved.
      if (code === "ELOOP") return { _tag: "outside" };
      if (code === "ENOENT") return { _tag: "missing" };
      return { _tag: "unreadable" };
    }
    const fd = opened.success;
    const info = yield* fstat(fd).pipe(Effect.option);
    if (Option.isNone(info)) return { _tag: "unreadable" };
    if (!info.value.isFile()) return { _tag: "not-a-file" };

    // Where the open landed. A folder on the way swapped for a link after
    // the path was resolved shows here, on Linux also when it is swapped back.
    const landed =
      process.platform === "linux"
        ? yield* fs.readLink(`/proc/self/fd/${fd}`).pipe(
            Effect.map(isInside),
            Effect.orElseSucceed(() => false),
          )
        : yield* Effect.gen(function* () {
            const again = yield* fs.realPath(real).pipe(Effect.option);
            if (Option.isNone(again) || again.value !== real) return false;
            const atPath = yield* stat(real).pipe(Effect.option);
            return (
              Option.isSome(atPath) &&
              atPath.value.dev === info.value.dev &&
              atPath.value.ino === info.value.ino
            );
          });
    if (!landed) return { _tag: "outside" };

    const bytes = yield* readBounded(fd, limit).pipe(Effect.option);
    if (Option.isNone(bytes)) return { _tag: "unreadable" };
    if (bytes.value === undefined) return { _tag: "too-large" };
    return { _tag: "read", name: path.basename(real), bytes: bytes.value };
  }, Effect.scoped);
  return read;
});
