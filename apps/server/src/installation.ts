// SPDX-License-Identifier: AGPL-3.0-or-later
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";

// Where this copy of J3 Bots is, so it can point at its own files: the
// executable a service unit starts, the bridge each harness starts, and the
// web client built next to it. The server runs either from source
// (`src/bin.ts`, Node strips the types) or from its bundle (`dist/bin.mjs`).
// This module sits directly in `src/`, and its bundled copy directly in
// `dist/`, so a path relative to it means the same folder in both.

const fromSource = import.meta.url.endsWith(".ts");

/** A file next to this module, named for source and for the bundle. */
const sibling = Effect.fn("installation.sibling")(function* (source: string, bundled: string) {
  const path = yield* Path.Path;
  return yield* path
    .fromFileUrl(new URL(fromSource ? source : bundled, import.meta.url))
    .pipe(Effect.orDie);
});

/** The CLI's entry point, which `j3-bots service install` makes the service start. */
export const entryPoint = sibling("./bin.ts", "./bin.mjs");

/** The `j3` stdio bridge, the MCP server each harness starts for the bot tools. */
export const bridgeEntryPoint = sibling("./bridge/main.ts", "./bridge.mjs");

/** The web client built in the same checkout: `apps/web/dist`. */
export const bundledWebClient = sibling("../../web/dist", "../../web/dist");
