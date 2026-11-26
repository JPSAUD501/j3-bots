// SPDX-License-Identifier: AGPL-3.0-or-later
// @effect-diagnostics nodeBuiltinImport:off -- a test of a shell script, against a node:http mirror signed with a node:crypto key.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";

// scripts/install.sh's check of a release: the signature over SHA256SUMS
// first, then the archive's digest in it, against a mirror signed with a key
// made for the test. The archive is a stand-in that only says its version, so
// this needs no release build; apps/server/smoke/install.test.ts installs a
// real one.

const SCRIPT = NodePath.join(import.meta.dirname, "install.sh");
const VERSION = "9.9.9";
const NIGHTLY = "9.9.10-nightly.20261124.57";
const ARCH = process.arch === "arm64" ? "arm64" : "x64";
const archiveName = (version: string) => `j3-bots-${version}-linux-${ARCH}.tar.gz`;
const ARCHIVE = archiveName(VERSION);
/** Where a release's files are: under its tag, `v<version>`, or a nightly's, its version alone. */
const downloadOf = (version: string) =>
  `/download/${version.includes("-nightly.") ? version : `v${version}`}`;
const DOWNLOAD = downloadOf(VERSION);

const scratch: Array<string> = [];
const servers: Array<NodeHttp.Server> = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.close();
  for (const folder of scratch.splice(0)) NodeFS.rmSync(folder, { recursive: true, force: true });
});

const folder = (prefix: string) => {
  const made = NodeFS.realpathSync(NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), prefix)));
  scratch.push(made);
  return made;
};

const sha256 = (bytes: Uint8Array) => NodeCrypto.createHash("sha256").update(bytes).digest("hex");

const keyPair = () => {
  const { privateKey, publicKey } = NodeCrypto.generateKeyPairSync("ed25519");
  return {
    sign: (bytes: Uint8Array) => `${NodeCrypto.sign(null, bytes, privateKey).toString("base64")}\n`,
    publicKey: publicKey.export({ type: "spki", format: "pem" }).toString(),
  };
};

/** The stand-in release archive: a release.json and a j3-bots that says its version. */
const archive = (() => {
  const made = new Map<string, Buffer>();
  return (version = VERSION) => {
    const found = made.get(version);
    if (found !== undefined) return found;
    const root = folder("j3-install-archive-");
    const name = archiveName(version);
    const stem = name.slice(0, -".tar.gz".length);
    NodeFS.mkdirSync(NodePath.join(root, stem, "bin"), { recursive: true });
    NodeFS.writeFileSync(NodePath.join(root, stem, "release.json"), `{"version":"${version}"}\n`);
    NodeFS.writeFileSync(
      NodePath.join(root, stem, "bin", "j3-bots"),
      `#!/bin/sh\necho "j3-bots v${version}"\n`,
      { mode: 0o755 },
    );
    NodeChildProcess.execFileSync("tar", ["-czf", name, stem], { cwd: root });
    const bytes = NodeFS.readFileSync(NodePath.join(root, name));
    made.set(version, bytes);
    return bytes;
  };
})();

/** A mirror of a release page serving `files` by path, noting each path asked for. */
const mirror = async (files: ReadonlyMap<string, string | Uint8Array>) => {
  const served: Array<string> = [];
  const server = NodeHttp.createServer((request, response) => {
    const path = request.url ?? "/";
    served.push(path);
    const body = files.get(path);
    if (body === undefined) response.writeHead(404).end();
    else response.writeHead(200).end(body);
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = address !== null && typeof address === "object" ? address.port : 0;
  return { url: `http://127.0.0.1:${port}`, served };
};

/** The release's files: the archive and SHA256SUMS, signed by `signer` unless a part is replaced. */
const release = (
  signer: ReturnType<typeof keyPair>,
  replaced: { readonly digest?: string; readonly sums?: string; readonly signature?: string } = {},
  version = VERSION,
) => {
  const name = archiveName(version);
  const download = downloadOf(version);
  const sums = `${replaced.digest ?? sha256(archive(version))}  ${name}\n`;
  const files = new Map<string, string | Uint8Array>([
    [`${download}/${name}`, archive(version)],
    [`${download}/SHA256SUMS`, replaced.sums ?? sums],
  ]);
  const signature = replaced.signature ?? signer.sign(Buffer.from(sums));
  if (signature !== "") files.set(`${download}/SHA256SUMS.sig`, signature);
  return files;
};

/**
 * A search path of links to every command on this PATH but those in
 * `left`, and a `sh` script for each in `replaced`.
 */
const searchPath = (left: ReadonlyArray<string>, replaced: Readonly<Record<string, string>>) => {
  const commands = folder("j3-install-path-");
  const linked = new Set(left);
  for (const [name, body] of Object.entries(replaced)) {
    linked.add(name);
    NodeFS.writeFileSync(NodePath.join(commands, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  }
  for (const directory of (process.env["PATH"] ?? "").split(":")) {
    if (directory === "" || !NodeFS.existsSync(directory)) continue;
    for (const name of NodeFS.readdirSync(directory)) {
      if (linked.has(name)) continue;
      linked.add(name);
      NodeFS.symlinkSync(NodePath.join(directory, name), NodePath.join(commands, name));
    }
  }
  return commands;
};

/** install.sh run for a new home against `url`, with `env` added. */
const install = (
  url: string | undefined,
  env: Readonly<Record<string, string>> = {},
  path: { readonly left?: ReadonlyArray<string>; readonly replaced?: Record<string, string> } = {},
  version = VERSION,
) => {
  const home = folder("j3-install-home-");
  return new Promise<{ code: number | null; output: string; home: string }>((resolve) => {
    const child = NodeChildProcess.spawn("sh", [SCRIPT, "--version", version, "--no-service"], {
      env: {
        PATH: searchPath(path.left ?? [], path.replaced ?? {}),
        HOME: home,
        LANG: "C.UTF-8",
        ...(url === undefined ? {} : { J3_RELEASE_BASE_URL: url }),
        ...env,
      },
    });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()));
    child.on("close", (code) => resolve({ code, output, home }));
  });
};

const installed = (home: string, version = VERSION) =>
  NodeFS.existsSync(NodePath.join(home, ".local", "share", "j3-bots", "versions", version)) ||
  NodeFS.existsSync(NodePath.join(home, ".local", "bin", "j3-bots"));

describe("install.sh", () => {
  it("installs a release whose SHA256SUMS is signed and whose archive matches it", async () => {
    const signer = keyPair();
    const site = await mirror(release(signer));
    const result = await install(site.url, { J3_RELEASE_PUBLIC_KEY: signer.publicKey });
    expect(result.code, result.output).toBe(0);
    expect(result.output).toContain(`J3 Bots ${VERSION} is installed`);
    expect(installed(result.home)).toBe(true);
    // The signature is checked before the archive is downloaded.
    expect(site.served).toEqual([
      `${DOWNLOAD}/SHA256SUMS`,
      `${DOWNLOAD}/SHA256SUMS.sig`,
      `${DOWNLOAD}/${ARCHIVE}`,
    ]);
  });

  it("downloads a nightly from its tag, which is its version with no v", async () => {
    const signer = keyPair();
    const site = await mirror(release(signer, {}, NIGHTLY));
    const result = await install(
      site.url,
      { J3_RELEASE_PUBLIC_KEY: signer.publicKey },
      {},
      NIGHTLY,
    );
    expect(result.code, result.output).toBe(0);
    expect(installed(result.home, NIGHTLY)).toBe(true);
    expect(site.served).toEqual([
      `/download/${NIGHTLY}/SHA256SUMS`,
      `/download/${NIGHTLY}/SHA256SUMS.sig`,
      `/download/${NIGHTLY}/${archiveName(NIGHTLY)}`,
    ]);
  });

  it("refuses a SHA256SUMS whose signature is missing or not a release key's, and downloads nothing else", async () => {
    const signer = keyPair();
    const other = keyPair();
    const sums = `${sha256(archive())}  ${ARCHIVE}\n`;
    const cases = [
      { name: "signed by another key", files: release(other), says: "does not match" },
      {
        name: "changed after it was signed",
        files: release(signer, { sums: `${sha256(Buffer.from("other"))}  ${ARCHIVE}\n` }),
        says: "does not match",
      },
      {
        name: "a signature that is not one line of base64",
        files: release(signer, { signature: signer.sign(Buffer.from(sums)).trimEnd() }),
        says: "does not match",
      },
      { name: "no signature", files: release(signer, { signature: "" }), says: "SHA256SUMS.sig" },
    ];
    for (const { name, files, says } of cases) {
      const site = await mirror(files);
      const result = await install(site.url, { J3_RELEASE_PUBLIC_KEY: signer.publicKey });
      expect(result.code, name).not.toBe(0);
      expect(result.output, name).toContain(says);
      expect(result.output, name).toContain("nothing was installed");
      expect(site.served, name).not.toContain(`${DOWNLOAD}/${ARCHIVE}`);
      expect(installed(result.home), name).toBe(false);
    }
  });

  it("checks a mirror against the release keys unless it names its own", async () => {
    const site = await mirror(release(keyPair()));
    const result = await install(site.url);
    expect(result.code, result.output).not.toBe(0);
    expect(result.output).toContain("does not match the J3 Bots release key");
    expect(site.served).not.toContain(`${DOWNLOAD}/${ARCHIVE}`);
  });

  it("refuses an archive that does not match its signed digest", async () => {
    const signer = keyPair();
    const site = await mirror(release(signer, { digest: sha256(Buffer.from("other")) }));
    const result = await install(site.url, { J3_RELEASE_PUBLIC_KEY: signer.publicKey });
    expect(result.code, result.output).not.toBe(0);
    expect(result.output).toContain("does not match its checksum in SHA256SUMS");
    expect(installed(result.home)).toBe(false);
  });

  it("refuses before any download without OpenSSL 3, and says how to get it", async () => {
    const cases = [
      { name: "OpenSSL 1.1.1", replaced: { openssl: 'echo "OpenSSL 1.1.1w  11 Sep 2023"' } },
      { name: "LibreSSL", replaced: { openssl: 'echo "LibreSSL 3.3.6"' } },
      { name: "no openssl", left: ["openssl"] },
    ];
    for (const { name, ...path } of cases) {
      const site = await mirror(release(keyPair()));
      const result = await install(site.url, {}, path);
      expect(result.code, name).not.toBe(0);
      expect(result.output, name).toContain("Install OpenSSL 3");
      expect(site.served, name).toEqual([]);
      expect(installed(result.home), name).toBe(false);
    }
  });

  it("takes a mirror's key only with the mirror", async () => {
    const result = await install(undefined, { J3_RELEASE_PUBLIC_KEY: keyPair().publicKey });
    expect(result.code, result.output).not.toBe(0);
    expect(result.output).toContain("taken only with J3_RELEASE_BASE_URL");
  });

  describe("refuses a folder another account could move away", () => {
    /** A folder in a new one of this user's, with `mode`, and the install folder made in it. */
    const within = (mode: number) => {
      const above = NodePath.join(folder("j3-install-above-"), "shared");
      NodeFS.mkdirSync(above);
      NodeFS.chmodSync(above, mode);
      const inside = NodePath.join(above, "j3-bots");
      NodeFS.mkdirSync(inside, { mode: 0o755 });
      return { above, inside };
    };

    it("when every account may write to a folder it is in, before any download", async () => {
      const { above, inside } = within(0o777);
      const signer = keyPair();
      const site = await mirror(release(signer));
      const result = await install(site.url, {
        J3_RELEASE_PUBLIC_KEY: signer.publicKey,
        J3_INSTALL_DIR: inside,
      });
      expect(result.code, result.output).not.toBe(0);
      expect(result.output).toContain(
        `${above}, a folder on the way to ${inside}, can be written by every account`,
      );
      expect(site.served).toEqual([]);
    });

    it("when a link on its way is in such a folder, though it leads to a private one", async () => {
      const { above } = within(0o777);
      const own = NodePath.join(folder("j3-install-own-"), "j3-bots");
      NodeFS.mkdirSync(own, { mode: 0o755 });
      NodeFS.symlinkSync(own, NodePath.join(above, "hop"));
      const link = NodePath.join(folder("j3-install-link-"), "j3-bots");
      NodeFS.symlinkSync(NodePath.join(above, "hop"), link);
      const signer = keyPair();
      const site = await mirror(release(signer));
      const result = await install(site.url, {
        J3_RELEASE_PUBLIC_KEY: signer.publicKey,
        J3_INSTALL_DIR: link,
      });
      expect(result.code, result.output).not.toBe(0);
      expect(result.output).toContain(`${above}, a folder on the way to ${link}, can be written`);
      expect(site.served).toEqual([]);
    });

    it("but not in a sticky folder, as /tmp is, or one only its own group may write", async () => {
      for (const mode of [0o1777, 0o775]) {
        const { inside } = within(mode);
        const signer = keyPair();
        const site = await mirror(release(signer));
        const result = await install(site.url, {
          J3_RELEASE_PUBLIC_KEY: signer.publicKey,
          J3_INSTALL_DIR: inside,
        });
        expect(result.code, `${mode.toString(8)}: ${result.output}`).toBe(0);
        expect(NodeFS.existsSync(NodePath.join(inside, "versions", VERSION))).toBe(true);
      }
    });
  });
});
