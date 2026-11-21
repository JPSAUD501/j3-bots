// SPDX-License-Identifier: AGPL-3.0-or-later
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

// Where this copy of J3 Bots is, so it can point at its own files: the
// executable a service unit starts, the bridge each harness starts, and the
// web client it serves. It runs in one of two layouts
// (docs/decisions/0015-a-release-is-a-self-contained-archive.md):
//
// - a checkout: from source (`apps/server/src/bin.ts`, Node strips the types)
//   or from its bundle (`apps/server/dist/bin.mjs`), with the web client built
//   in `apps/web/dist`;
// - a release archive: the bundle in `server/`, the web client in `web/` and
//   `release.json` at the archive's root, which marks the layout.
//
// This module sits directly in `src/`, and its bundled copy directly in the
// bundle's folder, so a path relative to it means the same folder in both.
// The prompt files travel with the bundle, in `templates/` and `skills/`
// beside it in either layout, and `@j3-bots/prompts` reads them from there.

/** The file at a release archive's root that says it is one. */
export const RELEASE_MANIFEST = "release.json";

/** What `scripts/build-release.ts` writes to `release.json`. */
export const ReleaseManifest = Schema.Struct({
  /** The J3 Bots release, as `j3-bots --version` prints it. */
  version: Schema.String,
  /** The platform the archive's Node runs on, such as `linux-x64`. */
  platform: Schema.String,
  /** The Node release in `node/`. */
  node: Schema.String,
});
export type ReleaseManifest = typeof ReleaseManifest.Type;

const decodeManifest = Schema.decodeUnknownEffect(Schema.fromJsonString(ReleaseManifest));

/**
 * A release archive whose manifest does not decode: nothing can run from it.
 * Every command that needs this copy's files fails with it, and says only that.
 */
class ReleaseDamaged extends Schema.TaggedError<ReleaseDamaged>()("ReleaseDamaged", {
  manifest: Schema.String,
}) {
  override get message(): string {
    return `${this.manifest} is not a release manifest J3 Bots can read. Unpack the release again.`;
  }
}

type Layout =
  | { readonly _tag: "checkout" }
  | { readonly _tag: "release"; readonly root: string; readonly manifest: ReleaseManifest };

export interface Installation {
  readonly layout: Layout;
  /** The CLI's entry point, which `j3-bots service install` makes the service start. */
  readonly entryPoint: string;
  /** The `j3` stdio bridge, the MCP server each harness starts for the bot tools. */
  readonly bridgeEntryPoint: string;
  /** The web client that comes with this copy: built in the checkout, or in the archive. */
  readonly webClient: string;
}

/**
 * The installation whose code is the module at `moduleUrl`: this module's own
 * URL, from source or bundled. A `release.json` beside the bundle's folder
 * that does not decode is a damaged release, which nothing can run from.
 */
export const locate = Effect.fn("installation.locate")(function* (moduleUrl: URL) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const here = path.dirname(yield* path.fromFileUrl(moduleUrl).pipe(Effect.orDie));
  if (moduleUrl.pathname.endsWith(".ts")) {
    return {
      layout: { _tag: "checkout" },
      entryPoint: path.join(here, "bin.ts"),
      bridgeEntryPoint: path.join(here, "bridge", "main.ts"),
      webClient: path.resolve(here, "../../web/dist"),
    } satisfies Installation;
  }
  const root = path.dirname(here);
  const manifestFile = path.join(root, RELEASE_MANIFEST);
  const bundled = {
    entryPoint: path.join(here, "bin.mjs"),
    bridgeEntryPoint: path.join(here, "bridge.mjs"),
  };
  if (!(yield* fs.exists(manifestFile).pipe(Effect.orDie))) {
    return {
      layout: { _tag: "checkout" },
      ...bundled,
      webClient: path.resolve(here, "../../web/dist"),
    } satisfies Installation;
  }
  const manifest = yield* fs.readFileString(manifestFile).pipe(
    Effect.flatMap(decodeManifest),
    Effect.mapError(() => new ReleaseDamaged({ manifest: manifestFile })),
  );
  return {
    layout: { _tag: "release", root, manifest },
    ...bundled,
    webClient: path.join(root, "web"),
  } satisfies Installation;
});

/** This copy of J3 Bots. */
export const installation = locate(new URL(import.meta.url));
