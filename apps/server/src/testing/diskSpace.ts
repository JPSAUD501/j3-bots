// SPDX-License-Identifier: AGPL-3.0-or-later
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { DiskSpace } from "../system/DiskSpace.ts";

/** What a disk with plenty of room reports: 1 TiB free. */
const PLENTY = 1024 ** 4;

/** The free space the disk reports, which a test sets. */
export class TestDiskSpace extends Context.Service<
  TestDiskSpace,
  {
    /** Bytes free from now on; none for a disk whose free space cannot be read. */
    readonly set: (free: Option.Option<number>) => Effect.Effect<void>;
  }
>()("@j3-bots/server/testing/diskSpace/TestDiskSpace") {}

/** A disk with 1 TiB free until a test says otherwise, on every path. */
export const layer = Layer.effectContext(
  Effect.sync(() => {
    let free = Option.some(PLENTY);
    return Context.make(DiskSpace, DiskSpace.of({ free: () => Effect.sync(() => free) })).pipe(
      Context.add(
        TestDiskSpace,
        TestDiskSpace.of({
          set: (next) =>
            Effect.sync(() => {
              free = next;
            }),
        }),
      ),
    );
  }),
);
