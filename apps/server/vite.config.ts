// SPDX-License-Identifier: AGPL-3.0-or-later
// @effect-diagnostics-next-line nodeBuiltinImport:off -- tsdown reads the copy source as a path when it loads this config.
import * as NodePath from "node:path";
import { defineConfig } from "vite-plus";
import { bundleInputs } from "../../scripts/bundle-inputs.ts";

// The production build (`vp pack`, tsdown), after T3 Code's: one ESM file per
// entry with every dependency bundled in, so `dist/` runs on Node with no
// `node_modules`. SQLite is Node's own. Tests use the root configuration.

/**
 * `@j3-bots/prompts` reads its templates from `./templates/` and its skills
 * from `./skills/`, next to its own module. Bundled, that module is a chunk
 * directly in `dist/`, so they go to `dist/templates/` and `dist/skills/`.
 */
const promptFiles = (folder: string) =>
  NodePath.join(import.meta.dirname, `../../packages/prompts/src/${folder}/*.md`);

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
    // What the release's third-party notices are made from (scripts/build-release.ts).
    plugins: [bundleInputs("server")],
  },
});
