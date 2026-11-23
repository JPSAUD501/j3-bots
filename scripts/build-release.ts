// SPDX-License-Identifier: AGPL-3.0-or-later
// @effect-diagnostics nodeBuiltinImport:off globalConsole:off -- a build script run by plain Node, outside any Effect program.
//
// Builds what a release of J3 Bots holds for one platform
// (docs/decisions/0015-a-release-is-a-self-contained-archive.md):
//
//   pnpm release [--platform <platform>] [--out <folder>] [--server-runtime]
//
// The platform defaults to this machine's, and the folder to dist/release.
// It writes what the platform has (scripts/release-layout.ts says which, and
// what each holds):
//
// - the server archive, j3-bots-<version>-<platform>.tar.gz, which install.sh
//   installs: one folder with the server's files, its web client in web/ and
//   bin/j3-bots, an sh launcher that runs the bundle on the Node beside it;
// - the server runtime the desktop packages carry, server-runtime/<platform>/,
//   the same files without web/ or the launcher, which electron-builder.yml
//   takes into each package.
//
// --server-runtime builds only the runtime, as the desktop packages need.
//
// Needs the network, to reach nodejs.org. The archive needs GNU tar, and Node
// for Linux or macOS tar and xz; Node for Windows is unpacked in-process.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import { BUNDLE_INPUTS_FOLDER } from "./bundle-inputs.ts";
import {
  PLATFORMS,
  type Platform,
  downloadNode,
  field,
  hostPlatform,
  isPlatform,
  nodePin,
  platformBuild,
  readJson,
  required,
  stageServer,
  text,
  unpackNode,
} from "./release-layout.ts";

const ROOT = NodePath.resolve(import.meta.dirname, "..");
const WEB = NodePath.join(ROOT, "apps", "web");
const SERVER = NodePath.join(ROOT, "apps", "server");

/** Starts the bundle on the Node beside it, from wherever the release is unpacked or linked. */
const LAUNCHER = `#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-or-later
# J3 Bots, run on the Node.js that comes with this release.
set -eu
release=$(dirname -- "$(dirname -- "$(readlink -f -- "$0")")")
exec "$release/node/bin/node" "$release/server/bin.mjs" "$@"
`;

const texts = (value: unknown): ReadonlyArray<string> =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];

// ---------------------------------------------------------------------------

/**
 * Runs `command`. On Windows it goes through the shell, which is what finds
 * `vp` there whatever form it is installed in (an .exe or a .cmd shim, which
 * Node no longer starts without one); the arguments are this script's own.
 */
const run = (command: string, args: ReadonlyArray<string>, cwd: string, env = process.env) => {
  const result = NodeChildProcess.spawnSync(command, args, {
    cwd,
    env,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) {
    throw new Error(`\`${[command, ...args].join(" ")}\` in ${cwd} exited with ${result.status}.`);
  }
};

const sha256 = (bytes: Uint8Array) => NodeCrypto.createHash("sha256").update(bytes).digest("hex");

/** The bytes a folder's files take, links not followed. */
const folderSize = (folder: string): number =>
  NodeFS.readdirSync(folder, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile())
    .reduce(
      (total, entry) => total + NodeFS.statSync(NodePath.join(entry.parentPath, entry.name)).size,
      0,
    );

const megabytes = (bytes: number) => `${(bytes / 1024 ** 2).toFixed(1)} MB`;

// ---------------------------------------------------------------------------
// Third-party notices, from what each bundle holds (scripts/bundle-inputs.ts).

type Part = "server" | "web";

interface ThirdParty {
  readonly name: string;
  readonly version: string;
  readonly license: string;
  /** Each license or notice file the package ships, by name. */
  readonly files: ReadonlyArray<{ readonly name: string; readonly text: string }>;
  /** Where it is in the release: `server`, `web`. */
  readonly parts: Set<Part>;
}

const LICENSE_FILE = /^(licen[cs]e|copying|notice)([.\-_].*)?$/i;

/** Each folder looked at, and the package folder that holds it. */
const owners = new Map<string, string>();

/** The folder of the package that holds `file`: the nearest package.json with a name. */
const packageOf = (file: string): string => {
  const visited: Array<string> = [];
  let folder = NodePath.dirname(file);
  let owner = owners.get(folder);
  while (owner === undefined) {
    visited.push(folder);
    const manifest = NodePath.join(folder, "package.json");
    if (NodeFS.existsSync(manifest) && text(readJson(manifest), "name") !== undefined) {
      owner = folder;
      break;
    }
    const parent = NodePath.dirname(folder);
    if (parent === folder) throw new Error(`No package holds ${file}.`);
    folder = parent;
    owner = owners.get(folder);
  }
  for (const seen of visited) owners.set(seen, owner);
  return owner;
};

/** J3 Bots' own packages, under LICENSE: in this repository and not installed from a registry. */
const isFirstParty = (folder: string, name: string) => {
  const relative = NodePath.relative(ROOT, folder);
  return (
    !relative.startsWith("..") &&
    !relative.split(NodePath.sep).includes("node_modules") &&
    name.startsWith("@j3-bots/")
  );
};

/** The license a package declares: `license`, or the older `licenses` list. */
const declaredLicense = (manifest: unknown) => {
  const license = text(manifest, "license");
  if (license !== undefined) return license;
  const listed = field(manifest, "licenses");
  const types = Array.isArray(listed) ? listed.map((entry) => text(entry, "type")) : [];
  const names = types.filter((type): type is string => type !== undefined);
  return names.length > 0 ? names.join(" OR ") : undefined;
};

const isPart = (value: string | undefined): value is Part => value === "server" || value === "web";

/** The input files of every output the builds of `parts` recorded, by the part they went to. */
const recordedInputs = (folder: string, parts: ReadonlyArray<Part>) => {
  const inputs: Array<{ readonly part: Part; readonly file: string }> = [];
  for (const entry of NodeFS.readdirSync(folder).sort()) {
    const part = /^(server|web)-\d+\.json$/.exec(entry)?.[1];
    if (!isPart(part)) continue;
    const recorded = readJson(NodePath.join(folder, entry));
    const root = required(text(recorded, "root"), `The build root in ${entry}`);
    for (const id of [...texts(field(recorded, "modules")), ...texts(field(recorded, "assets"))]) {
      // A virtual module is the bundler's own glue, such as Vite's preload helper.
      if (id.startsWith("\0")) continue;
      const file = id.split("?")[0] ?? id;
      if (file === "") continue;
      // Another scheme than a file's (`data:`, `node:`); a Windows drive (`C:`) is a file's.
      if (!NodePath.isAbsolute(file) && /^[a-z][a-z0-9+.-]+:/i.test(file)) continue;
      inputs.push({ part, file: NodePath.resolve(root, file) });
    }
  }
  const missing = parts.filter((part) => !inputs.some((input) => input.part === part));
  if (missing.length > 0) {
    throw new Error(
      `The ${missing.join(" and ")} build recorded no inputs in ${folder}; is the bundle-inputs plugin on?`,
    );
  }
  return inputs;
};

/**
 * Packages whose text a compiler writes into a bundle without making it a
 * module, so no bundler records it, each found from its part's package through
 * the packages that install it:
 *
 * - Tailwind CSS resolves its own stylesheets (`@import "tailwindcss"`) and
 *   writes its base styles into the web client's.
 * - Rolldown, which builds both bundles, writes its runtime helpers into each.
 *   It ships inside `@voidzero-dev/vite-plus-core`, which `vite-plus` installs
 *   under the name `vite`, and whose license file carries Rolldown's notice
 *   among those of the tools it bundles.
 */
const COMPILED_IN: ReadonlyArray<{
  readonly part: Part;
  readonly from: string;
  readonly through: ReadonlyArray<string>;
}> = [
  { part: "web", from: WEB, through: ["tailwindcss"] },
  { part: "server", from: SERVER, through: ["vite-plus", "vite"] },
  { part: "web", from: WEB, through: ["vite-plus", "vite"] },
];

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

const compiledIn = (parts: ReadonlyArray<Part>) =>
  COMPILED_IN.filter(({ part }) => parts.includes(part)).map(({ part, from, through }) => ({
    part,
    file: NodePath.join(through.reduce(installedFrom, from), "package.json"),
  }));

const thirdParties = (inputs: ReadonlyArray<{ readonly part: Part; readonly file: string }>) => {
  const found = new Map<string, ThirdParty>();
  for (const { part, file } of inputs) {
    const folder = packageOf(file);
    const manifest = readJson(NodePath.join(folder, "package.json"));
    const name = required(text(manifest, "name"), `The name in ${folder}/package.json`);
    if (isFirstParty(folder, name)) continue;
    const version = text(manifest, "version") ?? "unversioned";
    const key = `${name}@${version}`;
    const known = found.get(key);
    if (known !== undefined) {
      known.parts.add(part);
      continue;
    }
    const files = NodeFS.readdirSync(folder, { withFileTypes: true })
      .filter((entry) => entry.isFile() && LICENSE_FILE.test(entry.name))
      .map((entry) => entry.name)
      .sort()
      .map((entry) => ({
        name: entry,
        text: NodeFS.readFileSync(NodePath.join(folder, entry), "utf8"),
      }));
    const license = declaredLicense(manifest);
    if (license === undefined && files.length === 0) {
      throw new Error(`${key} (${folder}) declares no license and ships no license file.`);
    }
    found.set(key, {
      name,
      version,
      license: license ?? "see its license file",
      files,
      parts: new Set([part]),
    });
  }
  return [...found.values()].sort((a, b) =>
    a.name === b.name ? a.version.localeCompare(b.version) : a.name.localeCompare(b.name),
  );
};

/** The packages of `packages` that are in one of `parts`, each placed only there. */
const within = (packages: ReadonlyArray<ThirdParty>, parts: ReadonlyArray<Part>) =>
  packages.flatMap((entry) => {
    const kept = [...entry.parts].filter((part) => parts.includes(part));
    return kept.length === 0 ? [] : [{ ...entry, parts: new Set(kept) }];
  });

const RULE = "=".repeat(78);
const THIN = "-".repeat(78);

const notices = (
  release: { readonly version: string; readonly platform: Platform },
  node: { readonly version: string; readonly license: string },
  packages: ReadonlyArray<ThirdParty>,
  holder: "archive" | "folder",
) =>
  [
    `J3 Bots ${release.version} for ${release.platform}: third-party notices`,
    "",
    "J3 Bots is licensed under the GNU Affero General Public License, version 3",
    "or later (LICENSE), with an additional permission for app stores",
    `(APP-STORE-PERMISSION). This ${holder} also holds the third-party software below,`,
    "each under its own license. Each entry names the software, the folder it",
    "is in, the license it declares, and the license and notice files it ships,",
    "as it ships them.",
    "",
    RULE,
    `Node.js ${node.version}, in node/`,
    "License: MIT, with the licenses of its own dependencies below",
    THIN,
    node.license.trimEnd(),
    "",
    ...packages.flatMap((entry) => [
      RULE,
      `${entry.name} ${entry.version}, in ${[...entry.parts].sort().join("/ and ")}/`,
      `License: ${entry.license}`,
      ...(entry.files.length === 0
        ? ["(The package ships no license file.)", ""]
        : entry.files.flatMap((file) => [THIN, `${file.name}:`, "", file.text.trimEnd(), ""])),
    ]),
  ].join("\n");

// ---------------------------------------------------------------------------

const options = NodeUtil.parseArgs({
  options: {
    platform: { type: "string" },
    out: { type: "string" },
    "server-runtime": { type: "boolean", default: false },
  },
  strict: true,
}).values;
const platform = options.platform ?? hostPlatform();
if (platform === undefined || !isPlatform(platform)) {
  const named = platform ?? `this machine (${process.platform}-${process.arch})`;
  throw new Error(
    `J3 Bots builds nothing for ${named}. Name a platform with --platform: ${PLATFORMS.join(", ")}.`,
  );
}
const build = platformBuild(platform);
if (options["server-runtime"] && !build.serverRuntime) {
  const carried = PLATFORMS.filter((each) => platformBuild(each).serverRuntime);
  throw new Error(
    `No desktop package carries a server runtime for ${platform}, only for ${carried.join(", ")}.`,
  );
}
const withArchive = build.archive && !options["server-runtime"];
const withRuntime = build.serverRuntime;
const parts: ReadonlyArray<Part> = withArchive ? ["server", "web"] : ["server"];

const out = NodePath.resolve(options.out ?? NodePath.join(ROOT, "dist", "release"));
const version = required(
  text(readJson(NodePath.join(SERVER, "package.json")), "version"),
  "The version in apps/server/package.json",
);
const engine = required(
  text(readJson(NodePath.join(ROOT, "engine.json")), "version"),
  "The engine version in engine.json",
);

const work = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "j3-release-"));
try {
  const inputs = NodePath.join(work, "inputs");
  const withInputs = { ...process.env, [BUNDLE_INPUTS_FOLDER]: inputs };
  if (parts.includes("web")) run("vp", ["build"], WEB, withInputs);
  run("vp", ["pack"], SERVER, withInputs);
  const packages = thirdParties([...recordedInputs(inputs, parts), ...compiledIn(parts)]);
  const pin = nodePin(platform, readJson(NodePath.join(ROOT, "package.json")));
  const node = unpackNode(platform, pin, await downloadNode(pin), work);
  const stageInto = (stage: string, holder: "archive" | "folder") =>
    stageServer({
      stage,
      manifest: { version, platform, node: node.version, engine },
      node,
      serverBundle: NodePath.join(SERVER, "dist"),
      root: ROOT,
      notices: notices(
        { version, platform },
        node,
        within(packages, holder === "archive" ? ["server", "web"] : ["server"]),
        holder,
      ),
    });
  NodeFS.mkdirSync(out, { recursive: true });
  const report: Array<string> = [];

  if (withArchive) {
    const name = `j3-bots-${version}-${platform}`;
    const stage = NodePath.join(work, "stage", name);
    NodeFS.mkdirSync(NodePath.dirname(stage));
    stageInto(stage, "archive");
    NodeFS.mkdirSync(NodePath.join(stage, "bin"));
    NodeFS.writeFileSync(NodePath.join(stage, "bin", "j3-bots"), LAUNCHER, { mode: 0o755 });
    NodeFS.cpSync(NodePath.join(WEB, "dist"), NodePath.join(stage, "web"), {
      recursive: true,
      filter: (source) => !source.endsWith(".map"),
    });
    const archive = NodePath.join(out, `${name}.tar.gz`);
    run(
      "tar",
      [
        "--sort=name",
        "--owner=0",
        "--group=0",
        "--numeric-owner",
        "-czf",
        archive,
        "-C",
        NodePath.dirname(stage),
        name,
      ],
      work,
    );
    const bytes = NodeFS.readFileSync(archive);
    report.push(archive, `  ${megabytes(bytes.byteLength)}, SHA-256 ${sha256(bytes)}`);
  }

  if (withRuntime) {
    // Staged beside where it goes, so it replaces an earlier build in one rename.
    const runtimes = NodePath.join(out, "server-runtime");
    NodeFS.mkdirSync(runtimes, { recursive: true });
    const folder = NodePath.join(runtimes, platform);
    const stage = NodeFS.mkdtempSync(NodePath.join(runtimes, `.${platform}-`));
    NodeFS.rmdirSync(stage);
    try {
      stageInto(stage, "folder");
      NodeFS.rmSync(folder, { recursive: true, force: true });
      NodeFS.renameSync(stage, folder);
    } finally {
      NodeFS.rmSync(stage, { recursive: true, force: true });
    }
    report.push(folder, `  ${megabytes(folderSize(folder))} on disk`);
  }

  console.log(
    [
      ...report,
      `  Node.js ${pin.version} and ${within(packages, parts).length} third-party packages in THIRD_PARTY_NOTICES`,
    ].join("\n"),
  );
} finally {
  NodeFS.rmSync(work, { recursive: true, force: true });
}
