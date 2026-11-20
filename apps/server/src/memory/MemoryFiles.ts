// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  Conflict,
  Invalid,
  type MemoryDocument,
  type MemoryFile,
  MemoryPath,
  MemoryRevision,
  type MemoryScope,
} from "@j3-bots/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Digest from "effect/crypto/Digest";
import { Layout, type PrivateLocationExposed } from "../Layout.ts";
import { realLocation } from "../paths.ts";

const decodePath = Schema.decodeUnknownOption(MemoryPath);

/**
 * The memory files of a scope, as Markdown on disk. Every path is resolved
 * inside the scope's folder, symbolic links included, so no path a client or a
 * bot gives reaches a file outside it. Writes replace a file whole (written
 * to a new file beside it, then renamed: `Layout.writeFile`) and are
 * serialized, so a read-modify-write here never loses another one; a bot's own
 * file tools are outside that, which is why a client's write names the revision
 * it read.
 */
export class MemoryFiles extends Context.Service<
  MemoryFiles,
  {
    readonly list: (scope: MemoryScope) => Effect.Effect<ReadonlyArray<MemoryFile>>;
    /** `None` when the file does not exist. */
    readonly read: (
      scope: MemoryScope,
      path: MemoryPath,
    ) => Effect.Effect<Option.Option<MemoryDocument>, Invalid>;
    /**
     * Replaces the file's text if it is still at `revision`; `null` creates it
     * and fails if it exists. Fails with `Conflict("stale-revision")` otherwise,
     * and with `Conflict("private-location")` when the file would leave the
     * server's private data.
     */
    readonly write: (input: {
      readonly scope: MemoryScope;
      readonly path: MemoryPath;
      readonly text: string;
      readonly revision: MemoryRevision | null;
    }) => Effect.Effect<MemoryDocument, Invalid | Conflict>;
    /**
     * Reads the file (empty when missing), and writes what `change` returns
     * unless it returns `None`, as one step no other write here interleaves with.
     * Fails with `Conflict("private-location")` as `write` does.
     */
    readonly modify: <A>(
      scope: MemoryScope,
      path: MemoryPath,
      change: (text: string) => readonly [A, Option.Option<string>],
    ) => Effect.Effect<A, Invalid | Conflict>;
  }
>()("@j3-bots/server/memory/MemoryFiles") {}

export const layer = Layer.effect(
  MemoryFiles,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const layout = yield* Layout;
    const digest = yield* Digest.Digest;
    const writes = yield* Semaphore.make(1);
    const encoder = new TextEncoder();

    const rootOf = (scope: MemoryScope) =>
      scope._tag === "bot" ? layout.botMemory(scope.botId) : layout.sharedMemory;

    const revisionOf = Effect.fn("MemoryFiles.revisionOf")(function* (text: string) {
      return MemoryRevision.make(yield* digest.digestHex(Digest.sha256, encoder.encode(text)));
    });

    const isInside = (root: string, target: string) => {
      const relative = path.relative(root, target);
      return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
    };

    /** A write that would leave private state: nothing was written. */
    const exposed = (error: PrivateLocationExposed) =>
      Effect.logWarning(error.message).pipe(
        Effect.andThen(Effect.fail(new Conflict({ reason: "private-location" }))),
      );

    /**
     * The file's absolute path, refused unless it stays inside the scope's
     * folder, links resolved. Creates nothing.
     */
    const resolve = Effect.fn("MemoryFiles.resolve")(function* (
      scope: MemoryScope,
      file: MemoryPath,
    ) {
      const root = rootOf(scope);
      const target = path.resolve(root, file);
      if (!isInside(root, target)) return yield* new Invalid({ reason: "memory-path" });
      const locate = (location: string) =>
        realLocation(location).pipe(
          Effect.provideService(FileSystem.FileSystem, fs),
          Effect.provideService(Path.Path, path),
        );
      const realRoot = yield* locate(root);
      const real = yield* locate(target);
      if (Option.isNone(realRoot) || Option.isNone(real) || !isInside(realRoot.value, real.value)) {
        return yield* new Invalid({ reason: "memory-path" });
      }
      return target;
    });

    /**
     * `resolve`, for a write. The scope's folder, and then the file, must be
     * private (`Layout.writable`), the folder before it is created: a link
     * made while the server runs, the folder itself or one inside it such as
     * `log/`, may lead out of private state, and that is a refusal of its own,
     * not a path out of the scope.
     */
    const resolveForWrite = Effect.fn("MemoryFiles.resolveForWrite")(function* (
      scope: MemoryScope,
      file: MemoryPath,
    ) {
      const root = rootOf(scope);
      for (const location of [root, path.resolve(root, file)]) {
        yield* layout.writable(location).pipe(Effect.catchTag("PrivateLocationExposed", exposed));
      }
      yield* fs.makeDirectory(root, { recursive: true }).pipe(Effect.orDie);
      return yield* resolve(scope, file);
    });

    const readText = Effect.fn("MemoryFiles.readText")(function* (target: string) {
      if (!(yield* fs.exists(target))) return Option.none<string>();
      return Option.some(yield* fs.readFileString(target));
    }, Effect.orDie);

    const writeText = (target: string, text: string) =>
      layout
        .writeFile(target, text)
        .pipe(Effect.catchTags({ PrivateLocationExposed: exposed, PlatformError: Effect.die }));

    const list = Effect.fn("MemoryFiles.list")(function* (scope: MemoryScope) {
      const root = rootOf(scope);
      if (!(yield* fs.exists(root))) return [];
      const entries = yield* fs.readDirectory(root, { recursive: true });
      const files: Array<MemoryFile> = [];
      for (const entry of entries.toSorted()) {
        const memoryPath = decodePath(entry.split(path.sep).join("/"));
        if (Option.isNone(memoryPath)) continue;
        const info = yield* fs.stat(path.join(root, entry));
        if (info.type !== "File") continue;
        files.push({
          path: memoryPath.value,
          size: Number(info.size),
          updatedAt: Option.match(info.mtime, {
            onNone: () => DateTime.makeUnsafe(0),
            onSome: DateTime.fromDateUnsafe,
          }),
        });
      }
      return files;
    }, Effect.orDie);

    const read = Effect.fn("MemoryFiles.read")(function* (scope: MemoryScope, file: MemoryPath) {
      const text = yield* readText(yield* resolve(scope, file));
      if (Option.isNone(text)) return Option.none<MemoryDocument>();
      const document: MemoryDocument = {
        path: file,
        text: text.value,
        revision: yield* revisionOf(text.value),
      };
      return Option.some(document);
    });

    const write = Effect.fn("MemoryFiles.write")(function* (input: {
      readonly scope: MemoryScope;
      readonly path: MemoryPath;
      readonly text: string;
      readonly revision: MemoryRevision | null;
    }) {
      const target = yield* resolveForWrite(input.scope, input.path);
      const current = yield* readText(target);
      const currentRevision = Option.isSome(current) ? yield* revisionOf(current.value) : null;
      if (currentRevision !== input.revision) {
        return yield* new Conflict({ reason: "stale-revision" });
      }
      yield* writeText(target, input.text);
      const document: MemoryDocument = {
        path: input.path,
        text: input.text,
        revision: yield* revisionOf(input.text),
      };
      return document;
    }, writes.withPermits(1));

    const modify = Effect.fn("MemoryFiles.modify")(function* <A>(
      scope: MemoryScope,
      file: MemoryPath,
      change: (text: string) => readonly [A, Option.Option<string>],
    ) {
      const target = yield* resolveForWrite(scope, file);
      const current = yield* readText(target);
      const [result, next] = change(Option.getOrElse(current, () => ""));
      if (Option.isSome(next)) yield* writeText(target, next.value);
      return result;
    }, writes.withPermits(1));

    return MemoryFiles.of({ list, read, write, modify });
  }),
).pipe(Layer.provide(Digest.layerWebCrypto));
