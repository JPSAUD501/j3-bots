// SPDX-License-Identifier: AGPL-3.0-or-later
// @effect-diagnostics nodeBuiltinImport:off globalConsole:off globalFetch:off -- a build script run by plain Node, outside any Effect program.
//
// Builds the release archive of J3 Bots for one Linux platform, which runs
// with nothing installed on the host but sh, tar and the harnesses
// (docs/decisions/0015-a-release-is-a-self-contained-archive.md):
//
//   pnpm release [--platform linux-x64|linux-arm64] [--out <folder>]
//
// The platform defaults to this machine's, and the folder to dist/release.
// The archive, j3-bots-<version>-<platform>.tar.gz, holds one folder:
//
//   bin/j3-bots           runs the server bundle on the Node below
//   node/bin/node         the official Node release that package.json pins
//   server/               the server bundle, its prompt files beside it
//   web/                  the web client
//   release.json          what this copy is (apps/server/src/installation.ts)
//   LICENSE               J3 Bots' license
//   THIRD_PARTY_NOTICES   the license of everything above that J3 Bots did not write
//
// Needs GNU tar and xz, and the network to reach nodejs.org.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import { BUNDLE_INPUTS_FOLDER } from "./bundle-inputs.ts";

const ROOT = NodePath.resolve(import.meta.dirname, "..");
const WEB = NodePath.join(ROOT, "apps", "web");
const SERVER = NodePath.join(ROOT, "apps", "server");

const PLATFORMS = ["linux-x64", "linux-arm64"] as const;
type Platform = (typeof PLATFORMS)[number];
const isPlatform = (value: string): value is Platform =>
  PLATFORMS.some((platform) => platform === value);

/** Starts the bundle on the Node beside it, from wherever the release is unpacked or linked. */
const LAUNCHER = `#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-or-later
# J3 Bots, run on the Node.js that comes with this release.
set -eu
release=$(dirname -- "$(dirname -- "$(readlink -f -- "$0")")")
exec "$release/node/bin/node" "$release/server/bin.mjs" "$@"
`;

// ---------------------------------------------------------------------------
// Reading JSON written by others: each value is checked before it is used.

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const readJson = (file: string): unknown => JSON.parse(NodeFS.readFileSync(file, "utf8"));

const field = (value: unknown, key: string): unknown => (isRecord(value) ? value[key] : undefined);

const text = (value: unknown, key: string): string | undefined => {
  const found = field(value, key);
  return typeof found === "string" ? found : undefined;
};

const required = (value: string | undefined, what: string): string => {
  if (value === undefined || value === "") throw new Error(`${what} is missing.`);
  return value;
};

const texts = (value: unknown): ReadonlyArray<string> =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];

// ---------------------------------------------------------------------------

const run = (command: string, args: ReadonlyArray<string>, cwd: string, env = process.env) => {
  const result = NodeChildProcess.spawnSync(command, args, { cwd, env, stdio: "inherit" });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) {
    throw new Error(`\`${[command, ...args].join(" ")}\` in ${cwd} exited with ${result.status}.`);
  }
};

const sha256 = (bytes: Uint8Array) => NodeCrypto.createHash("sha256").update(bytes).digest("hex");

/** The pinned Node release for `platform`: `engines.node` and its checksum, both in package.json. */
const nodePin = (platform: Platform) => {
  const pkg = readJson(NodePath.join(ROOT, "package.json"));
  const version = required(text(field(pkg, "engines"), "node"), "`engines.node` in package.json");
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error(`\`engines.node\` in package.json is ${version}, not one exact release.`);
  }
  const tarball = `node-v${version}-${platform}.tar.xz`;
  const checksum = required(
    text(field(pkg, "nodeReleaseChecksums"), tarball),
    `The SHA-256 of ${tarball} in \`nodeReleaseChecksums\` of package.json`,
  );
  return { version, tarball, checksum };
};

/** Downloads the pinned Node and keeps only the executable and its license. */
const fetchNode = async (platform: Platform, work: string) => {
  const pin = nodePin(platform);
  const url = `https://nodejs.org/dist/v${pin.version}/${pin.tarball}`;
  console.log(`Downloading ${url}`);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} answered ${response.status}.`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  const actual = sha256(bytes);
  if (actual !== pin.checksum) {
    throw new Error(`${pin.tarball} has SHA-256 ${actual}; package.json pins ${pin.checksum}.`);
  }
  const tarball = NodePath.join(work, pin.tarball);
  NodeFS.writeFileSync(tarball, bytes);
  const unpacked = NodePath.join(work, "node");
  NodeFS.mkdirSync(unpacked);
  const top = pin.tarball.replace(/\.tar\.xz$/, "");
  run(
    "tar",
    ["-xJf", tarball, "-C", unpacked, "--strip-components=1", `${top}/bin/node`, `${top}/LICENSE`],
    work,
  );
  return {
    version: pin.version,
    executable: NodePath.join(unpacked, "bin", "node"),
    license: NodeFS.readFileSync(NodePath.join(unpacked, "LICENSE"), "utf8"),
  };
};

// ---------------------------------------------------------------------------
// Third-party notices, from what each bundle holds (scripts/bundle-inputs.ts).

interface ThirdParty {
  readonly name: string;
  readonly version: string;
  readonly license: string;
  /** Each license or notice file the package ships, by name. */
  readonly files: ReadonlyArray<{ readonly name: string; readonly text: string }>;
  /** Where it is in the archive: `server`, `web`. */
  readonly parts: Set<string>;
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

/** The input files of every output the builds recorded, by the part of the archive they went to. */
const recordedInputs = (folder: string) => {
  const inputs: Array<{ readonly part: string; readonly file: string }> = [];
  for (const entry of NodeFS.readdirSync(folder).sort()) {
    const part = /^(server|web)-\d+\.json$/.exec(entry)?.[1];
    if (part === undefined) continue;
    const recorded = readJson(NodePath.join(folder, entry));
    const root = required(text(recorded, "root"), `The build root in ${entry}`);
    for (const id of [...texts(field(recorded, "modules")), ...texts(field(recorded, "assets"))]) {
      // A virtual module is the bundler's own glue, such as Vite's preload helper.
      if (id.startsWith("\0")) continue;
      const file = id.split("?")[0] ?? id;
      if (file === "" || /^[a-z][a-z0-9+.-]*:/i.test(file)) continue;
      inputs.push({ part, file: NodePath.resolve(root, file) });
    }
  }
  const parts = new Set(inputs.map((input) => input.part));
  if (!parts.has("server") || !parts.has("web")) {
    throw new Error(`The builds recorded no inputs in ${folder}; is the bundle-inputs plugin on?`);
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
const COMPILED_IN = [
  { part: "web", from: WEB, through: ["tailwindcss"] },
  { part: "server", from: SERVER, through: ["vite-plus", "vite"] },
  { part: "web", from: WEB, through: ["vite-plus", "vite"] },
] as const;

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

const compiledIn = () =>
  COMPILED_IN.map(({ part, from, through }) => ({
    part,
    file: NodePath.join(through.reduce(installedFrom, from), "package.json"),
  }));

const thirdParties = (inputs: ReadonlyArray<{ readonly part: string; readonly file: string }>) => {
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

const RULE = "=".repeat(78);
const THIN = "-".repeat(78);

const notices = (
  release: { readonly version: string; readonly platform: Platform },
  node: { readonly version: string; readonly license: string },
  packages: ReadonlyArray<ThirdParty>,
) =>
  [
    `J3 Bots ${release.version} for ${release.platform}: third-party notices`,
    "",
    "J3 Bots is licensed under the GNU Affero General Public License, version 3",
    "or later (LICENSE). This archive also holds the third-party software below,",
    "each under its own license. Each entry names the software, the folder of",
    "this archive it is in, the license it declares, and the license and notice",
    "files it ships, as it ships them.",
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

const hostPlatform = (): Platform | undefined => {
  if (process.platform !== "linux") return undefined;
  const candidate = `linux-${process.arch}`;
  return isPlatform(candidate) ? candidate : undefined;
};

const options = NodeUtil.parseArgs({
  options: { platform: { type: "string" }, out: { type: "string" } },
  strict: true,
}).values;
const platform = options.platform ?? hostPlatform();
if (platform === undefined || !isPlatform(platform)) {
  throw new Error(`Name the platform to build for with --platform: ${PLATFORMS.join(" or ")}.`);
}
const out = NodePath.resolve(options.out ?? NodePath.join(ROOT, "dist", "release"));
const version = required(
  text(readJson(NodePath.join(SERVER, "package.json")), "version"),
  "The version in apps/server/package.json",
);
const name = `j3-bots-${version}-${platform}`;

const work = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "j3-release-"));
try {
  const inputs = NodePath.join(work, "inputs");
  const withInputs = { ...process.env, [BUNDLE_INPUTS_FOLDER]: inputs };
  run("vp", ["build"], WEB, withInputs);
  run("vp", ["pack"], SERVER, withInputs);
  const packages = thirdParties([...recordedInputs(inputs), ...compiledIn()]);
  const node = await fetchNode(platform, work);

  const stage = NodePath.join(work, "stage", name);
  const withoutSourceMaps = (source: string) => !source.endsWith(".map");
  NodeFS.mkdirSync(NodePath.join(stage, "bin"), { recursive: true });
  NodeFS.mkdirSync(NodePath.join(stage, "node", "bin"), { recursive: true });
  NodeFS.renameSync(node.executable, NodePath.join(stage, "node", "bin", "node"));
  NodeFS.writeFileSync(NodePath.join(stage, "bin", "j3-bots"), LAUNCHER, { mode: 0o755 });
  NodeFS.cpSync(NodePath.join(SERVER, "dist"), NodePath.join(stage, "server"), {
    recursive: true,
    filter: withoutSourceMaps,
  });
  NodeFS.cpSync(NodePath.join(WEB, "dist"), NodePath.join(stage, "web"), {
    recursive: true,
    filter: withoutSourceMaps,
  });
  NodeFS.copyFileSync(NodePath.join(ROOT, "LICENSE"), NodePath.join(stage, "LICENSE"));
  NodeFS.writeFileSync(
    NodePath.join(stage, "release.json"),
    `${JSON.stringify({ version, platform, node: node.version }, null, 2)}\n`,
  );
  NodeFS.writeFileSync(
    NodePath.join(stage, "THIRD_PARTY_NOTICES"),
    notices({ version, platform }, node, packages),
  );

  NodeFS.mkdirSync(out, { recursive: true });
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
  console.log(
    [
      `${archive}`,
      `  ${(bytes.byteLength / 1024 ** 2).toFixed(1)} MB, SHA-256 ${sha256(bytes)}`,
      `  Node.js ${node.version} and ${packages.length} third-party packages in THIRD_PARTY_NOTICES`,
    ].join("\n"),
  );
} finally {
  NodeFS.rmSync(work, { recursive: true, force: true });
}
