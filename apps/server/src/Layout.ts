// SPDX-License-Identifier: AGPL-3.0-or-later
import type { BotId } from "@j3-bots/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { ServerConfig } from "./config.ts";
import { homeLayout } from "./home/entries.ts";
import { isWithin, realLocation } from "./paths.ts";

/**
 * A location the server was about to write leads, through a symbolic link,
 * out of the home, into the web client's folder, or nowhere. Start refuses
 * such a home; this is a link made while the server runs.
 */
export class PrivateLocationExposed extends Schema.TaggedError<PrivateLocationExposed>()(
  "PrivateLocationExposed",
  { location: Schema.String },
) {
  override get message(): string {
    return `${this.location} leads out of the data directory, into the web client's folder, or nowhere, so the server did not write it.`;
  }
}

/**
 * Where J3 Bots keeps files under `J3_HOME` (see `home/entries.ts` and
 * `docs/architecture/server.md#data`), and the one check every private write
 * goes through.
 */
export class Layout extends Context.Service<
  Layout,
  {
    readonly workspace: (botId: BotId) => string;
    readonly botMemory: (botId: BotId) => string;
    readonly sharedMemory: string;
    readonly sharedSkills: string;
    readonly attachments: string;
    /**
     * `location`, once where it really is, links resolved (through its nearest
     * parent that exists, for one not created yet), is inside the home and
     * neither inside the web client's folder nor holding it. Every write of
     * private state checks its target here first.
     */
    readonly writable: (location: string) => Effect.Effect<string, PrivateLocationExposed>;
  }
>()("@j3-bots/server/Layout") {}

export const layer = Layer.effect(
  Layout,
  Effect.gen(function* () {
    const { home, webClient } = yield* ServerConfig;
    const path = yield* Path.Path;
    const layout = homeLayout(path, home);
    // Both resolved as start checked them: the home and the client's folder as they are now.
    const realHome = Option.getOrElse(yield* realLocation(home), () => path.resolve(home));
    const webRoot = Option.getOrElse(yield* realLocation(webClient.directory), () =>
      path.resolve(webClient.directory),
    );
    const fs = yield* FileSystem.FileSystem;

    const writable = Effect.fn("Layout.writable")(
      function* (location: string) {
        const real = yield* realLocation(location);
        if (
          Option.isNone(real) ||
          !isWithin(realHome, real.value) ||
          isWithin(webRoot, real.value) ||
          isWithin(real.value, webRoot)
        ) {
          return yield* new PrivateLocationExposed({ location });
        }
        return location;
      },
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
    );

    return Layout.of({
      workspace: layout.workspace,
      botMemory: layout.botMemory,
      sharedMemory: layout.sharedMemory,
      sharedSkills: layout.sharedSkills,
      attachments: layout.attachments,
      writable,
    });
  }),
);
