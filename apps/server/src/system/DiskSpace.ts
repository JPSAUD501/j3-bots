// SPDX-License-Identifier: AGPL-3.0-or-later
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import type * as Option from "effect/Option";
import * as Path from "effect/Path";
import { freeSpaceAt } from "./freeSpace.ts";

/**
 * How much room the disk has: a service, so a test can say the disk is full
 * without filling one.
 */
export class DiskSpace extends Context.Service<
  DiskSpace,
  {
    /**
     * Bytes free to this user on the filesystem holding `path`, or its
     * nearest folder that exists; none when that cannot be read.
     */
    readonly free: (path: string) => Effect.Effect<Option.Option<number>>;
  }
>()("@j3-bots/server/system/DiskSpace") {}

/** The machine's own disks. */
export const layer = Layer.effect(
  DiskSpace,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const free = Effect.fn("DiskSpace.free")(
      (target: string) => freeSpaceAt(target),
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
    );
    return DiskSpace.of({ free });
  }),
);
