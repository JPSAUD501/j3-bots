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

/** Writes `inputs` as the next output of `name`, when a release build asks for them. */
const record = (name: string, inputs: BundleInputs) => {
  const folder = process.env[BUNDLE_INPUTS_FOLDER];
  if (folder === undefined || folder === "") return;
  const outputs = (written.get(name) ?? 0) + 1;
  written.set(name, outputs);
  NodeFS.mkdirSync(folder, { recursive: true });
  NodeFS.writeFileSync(
    NodePath.join(folder, `${name}-${outputs}.json`),
    `${JSON.stringify(inputs, null, 2)}\n`,
  );
};

export function bundleInputs(name: string): Plugin {
  return {
    name: "j3-bots:bundle-inputs",
    generateBundle(_, bundle) {
      const modules = new Set<string>();
      const assets = new Set<string>();
      for (const output of Object.values(bundle)) {
        if (output.type === "chunk") for (const id of output.moduleIds) modules.add(id);
        else for (const file of output.originalFileNames) assets.add(file);
      }
      record(name, {
        root: process.cwd(),
        modules: [...modules].sort(),
        assets: [...assets].sort(),
      });
    },
  };
}

/** The folder, links resolved, of package `name` as Node finds it from `folder`. */
const installedFrom = (folder: string, name: string): string => {
  for (let at = folder; ; at = NodePath.dirname(at)) {
    const candidate = NodePath.join(at, "node_modules", name);
    if (NodeFS.existsSync(NodePath.join(candidate, "package.json"))) {
      return NodeFS.realpathSync(candidate);
    }
    if (NodePath.dirname(at) === at) throw new Error(`${name} is not installed for ${folder}.`);
  }
};

/** Whether a package's manifest names packages it needs at run time. */
const needsPackages = (manifest: unknown) =>
  typeof manifest === "object" &&
  manifest !== null &&
  "dependencies" in manifest &&
  typeof manifest.dependencies === "object" &&
  manifest.dependencies !== null &&
  Object.keys(manifest.dependencies).length > 0;

/**
 * Carries `packages`, which the build leaves out of its bundle, beside its
 * output as installed packages: each one's folder, as installed for the
 * build, copied to `node_modules/<package>` in the output folder, where Node
 * finds it from the bundle. For a package that reads its own files at run
 * time, from beside its modules, which a bundle would leave behind. Each must
 * need no package of its own. Each is recorded as an input of `name`, so the
 * release's third-party notices hold it.
 */
export function carriedPackages(name: string, packages: ReadonlyArray<string>): Plugin {
  return {
    name: "j3-bots:carried-packages",
    writeBundle(output) {
      const into = output.dir;
      if (into === undefined) return this.error("Carried packages need an output folder.");
      const root = process.cwd();
      const manifests: Array<string> = [];
      for (const each of packages) {
        const from = installedFrom(root, each);
        const manifest: unknown = JSON.parse(
          NodeFS.readFileSync(NodePath.join(from, "package.json"), "utf8"),
        );
        if (needsPackages(manifest)) {
          return this.error(`${each} needs packages of its own, which are not carried with it.`);
        }
        // A package manager may leave an empty node_modules in a package with no dependencies.
        const own = NodePath.join(from, "node_modules");
        NodeFS.cpSync(from, NodePath.join(into, "node_modules", each), {
          recursive: true,
          dereference: true,
          filter: (source) => source !== own,
        });
        manifests.push(NodePath.join(from, "package.json"));
      }
      record(name, { root, modules: [], assets: manifests.sort() });
    },
  };
}
