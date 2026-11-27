// SPDX-License-Identifier: AGPL-3.0-or-later
// @effect-diagnostics nodeBuiltinImport:off -- build tooling that runs in the bundler's Node process, outside any Effect program.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import type { Plugin } from "vite-plus";

/**
 * The folder a build writes its inputs to, when set. `scripts/build-release.ts`
 * sets it to collect the third-party notices of what each bundle holds; other
 * builds write nothing.
 */
export const BUNDLE_INPUTS_FOLDER = "J3_BUNDLE_INPUTS";

/** One output of one build: what went into it, as the bundler names it. */
interface BundleInputs {
  /** The folder the build ran in, against which a relative name resolves. */
  readonly root: string;
  /** Each module in a chunk: an absolute path, perhaps with a query, or a virtual id. */
  readonly modules: ReadonlyArray<string>;
  /** Each file an asset was emitted from, such as a font a stylesheet names. */
  readonly assets: ReadonlyArray<string>;
}

/**
 * Records every module and asset that reached the output, after the bundler
 * has shaken out what nothing uses, into `<BUNDLE_INPUTS_FOLDER>/<name>-<n>.json`,
 * one file per output written, a worker's build among them. Works in Vite and
 * in tsdown, both on Rolldown.
 */
// How many outputs each name has written, across every instance of the
// plugin: a web worker's build has its own, and its outputs count on.
const written = new Map<string, number>();

export function bundleInputs(name: string): Plugin {
  return {
    name: "j3-bots:bundle-inputs",
    generateBundle(_, bundle) {
      const folder = process.env[BUNDLE_INPUTS_FOLDER];
      if (folder === undefined || folder === "") return;
      const modules = new Set<string>();
      const assets = new Set<string>();
      for (const output of Object.values(bundle)) {
        if (output.type === "chunk") for (const id of output.moduleIds) modules.add(id);
        else for (const file of output.originalFileNames) assets.add(file);
      }
      const inputs: BundleInputs = {
        root: process.cwd(),
        modules: [...modules].sort(),
        assets: [...assets].sort(),
      };
      const outputs = (written.get(name) ?? 0) + 1;
      written.set(name, outputs);
      NodeFS.mkdirSync(folder, { recursive: true });
      NodeFS.writeFileSync(
        NodePath.join(folder, `${name}-${outputs}.json`),
        `${JSON.stringify(inputs, null, 2)}\n`,
      );
    },
  };
}
