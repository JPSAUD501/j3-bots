// SPDX-License-Identifier: AGPL-3.0-or-later
// @effect-diagnostics nodeBuiltinImport:off -- a test of a build script, run on files in a scratch folder.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeZlib from "node:zlib";
import { afterEach, describe, expect, it } from "vite-plus/test";
import {
  PLATFORMS,
  type Platform,
  checkServerRuntime,
  nodePin,
  platformBuild,
  readJson,
  stageServer,
  unpackNode,
} from "./release-layout.ts";

// The Node a release pins, and the server runtime the desktop packages carry,
// built from a stand-in Node release and server bundle in a scratch folder.

const ROOT = NodePath.resolve(import.meta.dirname, "..");
const PACKAGE = readJson(NodePath.join(ROOT, "package.json"));

const scratch: Array<string> = [];
afterEach(() => {
  for (const folder of scratch.splice(0)) NodeFS.rmSync(folder, { recursive: true, force: true });
});
const folder = () => {
  const made = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "j3-release-layout-"));
  scratch.push(made);
  return made;
};

const sha256 = (bytes: Uint8Array) => NodeCrypto.createHash("sha256").update(bytes).digest("hex");

/** A zip archive of `files`, each deflated, as Node's Windows release is packed. */
const zip = (files: ReadonlyArray<{ readonly name: string; readonly data: Uint8Array }>) => {
  const records: Array<Uint8Array> = [];
  const directory: Array<Uint8Array> = [];
  let offset = 0;
  for (const { name, data } of files) {
    const encoded = Buffer.from(name, "utf8");
    const compressed = NodeZlib.deflateRawSync(data);
    const crc = NodeZlib.crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.byteLength, 18);
    local.writeUInt32LE(data.byteLength, 22);
    local.writeUInt16LE(encoded.byteLength, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.byteLength, 20);
    central.writeUInt32LE(data.byteLength, 24);
    central.writeUInt16LE(encoded.byteLength, 28);
    central.writeUInt32LE(offset, 42);
    records.push(local, encoded, compressed);
    directory.push(central, encoded);
    offset += local.byteLength + encoded.byteLength + compressed.byteLength;
  }
  const centralDirectory = Buffer.concat(directory);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralDirectory.byteLength, 12);
  end.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...records, centralDirectory, end]));
};

/**
 * A stand-in for the pinned Node release for `platform`, packed as nodejs.org
 * packs it, with more in it than the executable and its license, and the pin
 * that matches its bytes.
 */
const nodeRelease = (platform: Platform) => {
  const real = nodePin(platform, PACKAGE);
  const { nodeFormat, nodeExecutable } = platformBuild(platform);
  const top = real.file.slice(0, -`.${nodeFormat}`.length);
  const files = [
    { name: `${top}/${nodeExecutable}`, data: Buffer.from(`node for ${platform}`) },
    { name: `${top}/LICENSE`, data: Buffer.from("Node.js is licensed for use as follows: MIT") },
    { name: `${top}/README.md`, data: Buffer.from("Node.js") },
    { name: `${top}/include/node/node.h`, data: Buffer.from("#pragma once") },
  ];
  let bytes: Uint8Array;
  if (nodeFormat === "zip") {
    bytes = zip(files);
  } else {
    const source = folder();
    for (const file of files) {
      const at = NodePath.join(source, file.name);
      NodeFS.mkdirSync(NodePath.dirname(at), { recursive: true });
      NodeFS.writeFileSync(at, file.data, { mode: 0o755 });
    }
    const archive = NodePath.join(source, real.file);
    NodeChildProcess.execFileSync("tar", ["-cJf", archive, "-C", source, top]);
    bytes = NodeFS.readFileSync(archive);
  }
  return { bytes, pin: { ...real, checksum: sha256(bytes) } };
};

/** A stand-in for the server bundle, with a source map that must stay behind. */
const serverBundle = () => {
  const bundle = folder();
  for (const file of ["bin.mjs", "bin.mjs.map", "bridge.mjs", "templates/soul.md"]) {
    const at = NodePath.join(bundle, file);
    NodeFS.mkdirSync(NodePath.dirname(at), { recursive: true });
    NodeFS.writeFileSync(at, file);
  }
  return bundle;
};

const filesIn = (root: string) =>
  NodeFS.readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => NodePath.relative(root, NodePath.join(entry.parentPath, entry.name)))
    .map((file) => file.split(NodePath.sep).join("/"))
    .sort();

const RUNTIME_PLATFORMS = PLATFORMS.filter((platform) => platformBuild(platform).serverRuntime);

const buildRuntime = (platform: Platform, version = "1.4.0") => {
  const { bytes, pin } = nodeRelease(platform);
  const work = folder();
  const node = unpackNode(platform, pin, bytes, work);
  const stage = NodePath.join(folder(), platform);
  stageServer({
    stage,
    manifest: { version, platform, node: node.version, engine: "0.1.11" },
    node,
    serverBundle: serverBundle(),
    root: ROOT,
    notices: "notices",
  });
  return stage;
};

describe("the pinned Node", () => {
  it.each(PLATFORMS)("is pinned with a checksum for %s", (platform) => {
    const pin = nodePin(platform, PACKAGE);
    expect(pin.url).toBe(`https://nodejs.org/dist/v${pin.version}/${pin.file}`);
  });

  it("fails the build for a platform package.json has no checksum for", () => {
    const withoutWindows = {
      engines: { node: "26.13.1" },
      nodeReleaseChecksums: { "node-v26.13.1-linux-x64.tar.xz": "a".repeat(64) },
    };
    expect(() => nodePin("win32-x64", withoutWindows)).toThrow(
      "The SHA-256 of node-v26.13.1-win-x64.zip in `nodeReleaseChecksums` of package.json is missing.",
    );
  });

  it.each(RUNTIME_PLATFORMS)(
    "refuses a %s download whose digest is not the pinned one, before unpacking it",
    (platform) => {
      const { bytes, pin } = nodeRelease(platform);
      const work = folder();
      const tampered = new Uint8Array(bytes);
      tampered[tampered.byteLength - 1] = (tampered[tampered.byteLength - 1] ?? 0) ^ 0xff;
      expect(() => unpackNode(platform, pin, tampered, work)).toThrow(
        `${pin.file} has SHA-256 ${sha256(tampered)}; package.json pins ${pin.checksum}.`,
      );
      expect(NodeFS.readdirSync(work)).toEqual([]);
    },
  );
});

describe("the server runtime", () => {
  it.each([
    ["linux-x64", "node/bin/node"],
    ["win32-x64", "node/node.exe"],
    ["darwin-arm64", "node/bin/node"],
  ] as const)(
    "for %s holds Node at %s, the bundle without source maps, release.json and the licenses",
    (platform, executable) => {
      const runtime = buildRuntime(platform);
      expect(filesIn(runtime)).toEqual(
        [
          "APP-STORE-PERMISSION",
          "LICENSE",
          "THIRD_PARTY_NOTICES",
          executable,
          "release.json",
          "server/bin.mjs",
          "server/bridge.mjs",
          "server/templates/soul.md",
        ].sort(),
      );
      expect(NodeFS.readFileSync(NodePath.join(runtime, executable), "utf8")).toBe(
        `node for ${platform}`,
      );
      expect(readJson(NodePath.join(runtime, "release.json"))).toEqual({
        version: "1.4.0",
        platform,
        node: "26.13.1",
        engine: "0.1.11",
      });
      expect(checkServerRuntime(runtime, { platform, version: "1.4.0" }).platform).toBe(platform);
    },
  );

  it("in a package is refused when it is another version's or another platform's", () => {
    const runtime = buildRuntime("linux-x64", "1.3.0");
    expect(() => checkServerRuntime(runtime, { platform: "linux-x64", version: "1.4.0" })).toThrow(
      "it is J3 Bots 1.3.0, not 1.4.0",
    );
    expect(() =>
      checkServerRuntime(runtime, { platform: "darwin-arm64", version: "1.3.0" }),
    ).toThrow("it is for linux-x64, not darwin-arm64");
  });

  it("in a package is refused when Node lost its executable bit or a web client is in it", () => {
    const runtime = buildRuntime("linux-x64");
    NodeFS.chmodSync(NodePath.join(runtime, "node", "bin", "node"), 0o644);
    NodeFS.mkdirSync(NodePath.join(runtime, "web"));
    expect(() => checkServerRuntime(runtime, { platform: "linux-x64", version: "1.4.0" })).toThrow(
      /node\/bin\/node is not executable; it holds web\/, which the app brings itself/,
    );
  });
});
