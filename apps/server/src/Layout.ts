// SPDX-License-Identifier: AGPL-3.0-or-later
import type { BotId } from "@j3-bots/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Hex from "effect/encoding/Hex";
import * as SecureRandom from "effect/crypto/SecureRandom";
import type * as PlatformError from "effect/PlatformError";
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
    /**
     * Replaces `file` whole, never half-written: checks its folder with
     * `writable`, creates it if missing, writes a new file of a random name
     * there that must not exist yet (so a link planted in its place is never
     * followed), then renames it over `file`. A link at `file` itself is
     * replaced, not followed.
     */
    readonly writeFile: (
      file: string,
      data: string | Uint8Array,
    ) => Effect.Effect<void, PrivateLocationExposed | PlatformError.PlatformError>;
  }
>()("@j3-bots/server/Layout") {}

/** Random bytes in a temporary file's name: never guessed ahead of the write. */
const TEMPORARY_NAME_BYTES = 12;

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
    const random = yield* SecureRandom.SecureRandom;

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

    const writeFile = Effect.fn("Layout.writeFile")(function* (
      file: string,
      data: string | Uint8Array,
    ) {
      const folder = yield* writable(path.dirname(file));
      yield* fs.makeDirectory(folder, { recursive: true });
      const suffix = Hex.encode(yield* random.randomBytes(TEMPORARY_NAME_BYTES));
      const temporary = path.join(folder, `.${path.basename(file)}.${suffix}.j3-writing`);
      const contents = typeof data === "string" ? new TextEncoder().encode(data) : data;
      yield* fs.writeFile(temporary, contents, { flag: "wx" }).pipe(
        Effect.andThen(fs.rename(temporary, file)),
        Effect.onError(() => fs.remove(temporary, { force: true }).pipe(Effect.ignore)),
      );
    });

    return Layout.of({
      workspace: layout.workspace,
      botMemory: layout.botMemory,
      sharedMemory: layout.sharedMemory,
      sharedSkills: layout.sharedSkills,
      attachments: layout.attachments,
      writable,
      writeFile,
    });
  }),
).pipe(Layer.provide(SecureRandom.layerWebCrypto));
