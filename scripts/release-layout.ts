// SPDX-License-Identifier: AGPL-3.0-or-later
// @effect-diagnostics nodeBuiltinImport:off globalConsole:off globalFetch:off -- a build script run by plain Node, outside any Effect program.
//
// What `pnpm release` builds for each platform, and the folder the server
// runs from in both of its forms
// (docs/decisions/0015-a-release-is-a-self-contained-archive.md):
//
// - the server archive, for install.sh on Linux;
// - the server runtime the desktop packages carry, for local mode, which is
//   the archive's folder without `web/` (the app has its own) and without the
//   `sh` launcher (the app starts Node itself).
//
// Both hold:
//
//   node/                 the official Node release that package.json pins:
//                         bin/node on Linux and macOS, node.exe on Windows
//   server/               the server bundle, its prompt files and the packages
//                         it carries (node_modules/) beside it
//   release.json          what this copy is (apps/server/src/installation.ts)
//   LICENSE               J3 Bots' license
//   APP-STORE-PERMISSION  its additional permission for app stores
//   THIRD_PARTY_NOTICES   the license of everything above that J3 Bots did not write
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { readZipEntries } from "./zip.ts";

// ---------------------------------------------------------------------------
// Reading JSON written by others: each value is checked before it is used.

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const readJson = (file: string): unknown => JSON.parse(NodeFS.readFileSync(file, "utf8"));

export const field = (value: unknown, key: string): unknown =>
  isRecord(value) ? value[key] : undefined;

export const text = (value: unknown, key: string): string | undefined => {
  const found = field(value, key);
  return typeof found === "string" ? found : undefined;
};

export const required = (value: string | undefined, what: string): string => {
  if (value === undefined || value === "") throw new Error(`${what} is missing.`);
  return value;
};

// ---------------------------------------------------------------------------
// Platforms, named as Node names them (`process.platform`-`process.arch`).

interface PlatformBuild {
  /** Node's own name for the platform, in the names of its release files. */
  readonly nodeName: string;
  /** How Node packs the release for it. */
  readonly nodeFormat: "tar.xz" | "zip";
  /** Where the executable is, in Node's release and in `node/` here. */
  readonly nodeExecutable: string;
  /** Has a server archive, which install.sh installs. */
  readonly archive: boolean;
  /** Has a server runtime, which the desktop packages carry. */
  readonly serverRuntime: boolean;
}

const PLATFORM_BUILDS = {
  "linux-x64": {
    nodeName: "linux-x64",
    nodeFormat: "tar.xz",
    nodeExecutable: "bin/node",
    archive: true,
    serverRuntime: true,
  },
  "linux-arm64": {
    nodeName: "linux-arm64",
    nodeFormat: "tar.xz",
    nodeExecutable: "bin/node",
    archive: true,
    serverRuntime: false,
  },
  "win32-x64": {
    nodeName: "win-x64",
    nodeFormat: "zip",
    nodeExecutable: "node.exe",
    archive: false,
    serverRuntime: true,
  },
  "darwin-arm64": {
    nodeName: "darwin-arm64",
    nodeFormat: "tar.xz",
    nodeExecutable: "bin/node",
    archive: false,
    serverRuntime: true,
  },
} as const satisfies Record<string, PlatformBuild>;

export type Platform = keyof typeof PLATFORM_BUILDS;

export const PLATFORMS = Object.keys(PLATFORM_BUILDS).filter(
  (name): name is Platform => name in PLATFORM_BUILDS,
);

export const isPlatform = (value: string): value is Platform =>
  PLATFORMS.some((platform) => platform === value);

export const platformBuild = (platform: Platform): PlatformBuild => PLATFORM_BUILDS[platform];

/** The platform this build runs on, if J3 Bots builds for it. */
export const hostPlatform = (): Platform | undefined => {
  const candidate = `${process.platform}-${process.arch}`;
  return isPlatform(candidate) ? candidate : undefined;
};

/** Where Node's executable is in a server runtime or an archive's folder, for `platform`. */
export const nodeExecutable = (folder: string, platform: Platform) =>
  NodePath.join(folder, "node", ...platformBuild(platform).nodeExecutable.split("/"));

// ---------------------------------------------------------------------------
// The pinned Node.

const sha256 = (bytes: Uint8Array) => NodeCrypto.createHash("sha256").update(bytes).digest("hex");

export interface NodePin {
  readonly version: string;
  /** The release file's name, such as `node-v26.13.1-win-x64.zip`. */
  readonly file: string;
  readonly url: string;
  /** Its SHA-256, in lowercase hex. */
  readonly checksum: string;
}

/**
 * The pinned Node release for `platform`, from the root package.json
 * (`manifest`): `engines.node`, one exact release, and the SHA-256 of its
 * file for the platform in `nodeReleaseChecksums`, as nodejs.org publishes it
 * in that release's SHASUMS256.txt. A platform without one fails the build.
 */
export const nodePin = (platform: Platform, manifest: unknown): NodePin => {
  const version = required(
    text(field(manifest, "engines"), "node"),
    "`engines.node` in package.json",
  );
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error(`\`engines.node\` in package.json is ${version}, not one exact release.`);
  }
  const { nodeName, nodeFormat } = platformBuild(platform);
  const file = `node-v${version}-${nodeName}.${nodeFormat}`;
  const checksum = required(
    text(field(manifest, "nodeReleaseChecksums"), file),
    `The SHA-256 of ${file} in \`nodeReleaseChecksums\` of package.json`,
  );
  if (!/^[0-9a-f]{64}$/.test(checksum)) {
    throw new Error(`The SHA-256 of ${file} in package.json is not 64 lowercase hex digits.`);
  }
  return { version, file, url: `https://nodejs.org/dist/v${version}/${file}`, checksum };
};

/** A Node release ready to stage: its executable on disk and its license. */
export interface UnpackedNode {
  readonly version: string;
  readonly executable: string;
  readonly license: string;
}

/**
 * Checks the downloaded `bytes` of `pin` against its checksum and keeps only
 * the executable and its license, in `work`. Bytes with another digest are
 * refused before anything is unpacked.
 */
export const unpackNode = (
  platform: Platform,
  pin: NodePin,
  bytes: Uint8Array,
  work: string,
): UnpackedNode => {
  const actual = sha256(bytes);
  if (actual !== pin.checksum) {
    throw new Error(`${pin.file} has SHA-256 ${actual}; package.json pins ${pin.checksum}.`);
  }
  const { nodeFormat, nodeExecutable: inside } = platformBuild(platform);
  const top = pin.file.slice(0, -`.${nodeFormat}`.length);
  const unpacked = NodePath.join(work, "node");
  const executable = NodePath.join(unpacked, ...inside.split("/"));
  NodeFS.mkdirSync(NodePath.dirname(executable), { recursive: true });
  if (nodeFormat === "zip") {
    const entries = readZipEntries(bytes, [`${top}/${inside}`, `${top}/LICENSE`]);
    for (const [name, data] of entries) {
      NodeFS.writeFileSync(NodePath.join(unpacked, name.slice(top.length + 1)), data, {
        mode: 0o755,
      });
    }
  } else {
    const archive = NodePath.join(work, pin.file);
    NodeFS.writeFileSync(archive, bytes);
    const result = NodeChildProcess.spawnSync(
      "tar",
      [
        "-xJf",
        archive,
        "-C",
        unpacked,
        "--strip-components=1",
        `${top}/${inside}`,
        `${top}/LICENSE`,
      ],
      { stdio: "inherit" },
    );
    if (result.error !== undefined) throw result.error;
    if (result.status !== 0) throw new Error(`tar could not unpack ${pin.file}.`);
  }
  return {
    version: pin.version,
    executable,
    license: NodeFS.readFileSync(NodePath.join(unpacked, "LICENSE"), "utf8"),
  };
};

/** Downloads `pin` from nodejs.org. */
export const downloadNode = async (pin: NodePin): Promise<Uint8Array> => {
  console.log(`Downloading ${pin.url}`);
  const response = await fetch(pin.url);
  if (!response.ok) throw new Error(`${pin.url} answered ${response.status}.`);
  return new Uint8Array(await response.arrayBuffer());
};

// ---------------------------------------------------------------------------
// The folder the server runs from.

/** What `release.json` says (apps/server/src/installation.ts, `ReleaseManifest`). */
export interface ReleaseManifest {
  readonly version: string;
  readonly platform: Platform;
  readonly node: string;
  readonly engine: string;
}

const RELEASE_MANIFEST = "release.json";

/** The files of J3 Bots' own license, at the repository's root. */
const LICENSES = ["LICENSE", "APP-STORE-PERMISSION"] as const;

const NOTICES = "THIRD_PARTY_NOTICES";

/**
 * Writes the folder the server runs from into `stage`, which must not exist:
 * Node, copied from where it was unpacked, the server bundle without its
 * source maps, `release.json`, J3 Bots' license files from `root`, and
 * `notices`. The archive adds its launcher and the web client to it.
 */
export const stageServer = (options: {
  readonly stage: string;
  readonly manifest: ReleaseManifest;
  readonly node: UnpackedNode;
  readonly serverBundle: string;
  readonly root: string;
  readonly notices: string;
}) => {
  const { stage, manifest } = options;
  NodeFS.mkdirSync(stage, { recursive: false });
  const executable = nodeExecutable(stage, manifest.platform);
  NodeFS.mkdirSync(NodePath.dirname(executable), { recursive: true });
  NodeFS.copyFileSync(options.node.executable, executable);
  NodeFS.chmodSync(executable, 0o755);
  NodeFS.cpSync(options.serverBundle, NodePath.join(stage, "server"), {
    recursive: true,
    filter: (source) => !source.endsWith(".map"),
  });
  for (const file of LICENSES) {
    NodeFS.copyFileSync(NodePath.join(options.root, file), NodePath.join(stage, file));
  }
  NodeFS.writeFileSync(
    NodePath.join(stage, RELEASE_MANIFEST),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  NodeFS.writeFileSync(NodePath.join(stage, NOTICES), options.notices);
};

/**
 * Checks that `folder` is a server runtime for `platform` at `version`: the
 * one a desktop package for that platform must carry. Returns its manifest;
 * throws, naming every problem, otherwise.
 */
export const checkServerRuntime = (
  folder: string,
  expected: { readonly platform: Platform; readonly version: string },
): ReleaseManifest => {
  const manifestFile = NodePath.join(folder, RELEASE_MANIFEST);
  if (!NodeFS.existsSync(manifestFile)) {
    throw new Error(`${folder} is not a server runtime: it has no ${RELEASE_MANIFEST}.`);
  }
  const read = readJson(manifestFile);
  const problems: Array<string> = [];
  const version = text(read, "version");
  const platform = text(read, "platform");
  const node = text(read, "node");
  const engine = text(read, "engine");
  if (version !== expected.version) {
    problems.push(`it is J3 Bots ${version ?? "(no version)"}, not ${expected.version}`);
  }
  if (platform !== expected.platform) {
    problems.push(`it is for ${platform ?? "(no platform)"}, not ${expected.platform}`);
  }
  if (node === undefined) problems.push(`its ${RELEASE_MANIFEST} names no Node release`);
  if (engine === undefined) problems.push(`its ${RELEASE_MANIFEST} names no engine`);
  const executable = nodeExecutable(folder, expected.platform);
  const files = [
    executable,
    NodePath.join(folder, "server", "bin.mjs"),
    NodePath.join(folder, "server", "bridge.mjs"),
    ...[...LICENSES, NOTICES].map((file) => NodePath.join(folder, file)),
  ];
  for (const file of files) {
    if (!NodeFS.existsSync(file)) problems.push(`${NodePath.relative(folder, file)} is missing`);
  }
  // Packaging must keep Node executable; Windows has no such bit to keep.
  if (
    process.platform !== "win32" &&
    expected.platform !== "win32-x64" &&
    NodeFS.existsSync(executable) &&
    (NodeFS.statSync(executable).mode & 0o111) === 0
  ) {
    problems.push(`${NodePath.relative(folder, executable)} is not executable`);
  }
  if (NodeFS.existsSync(NodePath.join(folder, "web"))) {
    problems.push("it holds web/, which the app brings itself");
  }
  if (problems.length > 0 || node === undefined || engine === undefined) {
    throw new Error(`The server runtime in ${folder} is wrong: ${problems.join("; ")}.`);
  }
  return { version: expected.version, platform: expected.platform, node, engine };
};
