// SPDX-License-Identifier: AGPL-3.0-or-later
// @effect-diagnostics nodeBuiltinImport:off -- tsdown reads the copy source as a path, and the release's notes as a file, when it loads this config.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { whatsNewOf } from "@j3-bots/release";
import { defineConfig, type Plugin } from "vite-plus";
import { bundleInputs } from "../../scripts/bundle-inputs.ts";
import packageJson from "./package.json" with { type: "json" };

// The production build (`vp pack`, tsdown), after T3 Code's: one ESM file per
// entry with every dependency bundled in, so `dist/` runs on Node with no
// `node_modules`. SQLite is Node's own. Tests use the root configuration.

/**
 * `@j3-bots/prompts` reads its templates from `./templates/` and its skills
 * from `./skills/`, next to its own module. Bundled, that module is a chunk
 * directly in `dist/`, so they go to `dist/templates/` and `dist/skills/`.
 * tsdown matches the source as a glob, whose separator is `/` on every
 * system: on Windows a `\` would escape the next character.
 */
const promptFiles = (folder: string) =>
  NodePath.join(import.meta.dirname, "../../packages/prompts/src", folder)
    .split(NodePath.sep)
    .join("/") + "/*.md";

/**
 * The release this build is, for the `j3-app` skill a bot reads: the version
 * in `package.json`, which the release workflow sets from the tag, and the
 * "What's new" section of `docs/releases/v<x.y.z>.md`, for a release and for
 * its release candidates. Written as `dist/release.json`, beside the chunk
 * `@j3-bots/prompts` is bundled in, which reads it there. A version with no
 * notes, a nightly's or the source's own `0.0.0`, writes none; notes with no
 * "What's new" fail the build, since the skill would say nothing changed.
 */
const releaseNotes = (): Plugin => ({
  name: "j3-bots:release-notes",
  generateBundle() {
    const version = packageJson.version;
    const release = /^(\d+\.\d+\.\d+)(?:-rc\.\d+)?$/.exec(version)?.[1];
    if (release === undefined) return;
    const notes = NodePath.join(import.meta.dirname, `../../docs/releases/v${release}.md`);
    if (!NodeFS.existsSync(notes)) return;
    const whatsNew = whatsNewOf(NodeFS.readFileSync(notes, "utf8"));
    if (whatsNew === null) {
      return this.error(`${notes} has no "What's new" section for the j3-app skill.`);
    }
    this.emitFile({
      type: "asset",
      fileName: "release.json",
      source: `${JSON.stringify({ version, whatsNew })}\n`,
    });
  },
});

/** Native accelerators `ws` loads when they are installed, and works without. */
const OPTIONAL_NATIVE = ["bufferutil", "utf-8-validate"];

export default defineConfig({
  pack: {
    // `src/installation.ts` names these outputs for the bundled build.
    entry: { bin: "src/bin.ts", bridge: "src/bridge/main.ts" },
    outDir: "dist",
    format: "esm",
    platform: "node",
    sourcemap: true,
    // An application, not a library: nothing imports its types.
    dts: false,
    clean: true,
    deps: {
      alwaysBundle: (id) => !id.startsWith("node:") && !OPTIONAL_NATIVE.includes(id),
      neverBundle: OPTIONAL_NATIVE,
      onlyBundle: false,
    },
    copy: [
      { from: promptFiles("templates"), to: "dist/templates" },
      { from: promptFiles("skills"), to: "dist/skills" },
    ],
    banner: { js: "#!/usr/bin/env node" },
    // What the release's third-party notices are made from (scripts/build-release.ts),
    // and the release the j3-app skill describes.
    plugins: [bundleInputs("server"), releaseNotes()],
  },
});
