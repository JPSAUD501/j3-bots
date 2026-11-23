// SPDX-License-Identifier: AGPL-3.0-or-later
// @effect-diagnostics nodeBuiltinImport:off -- the mirror is a node:http server, and its SHA256SUMS is made and signed with node:crypto.
import * as NodeCrypto from "node:crypto";
import * as NodeHttp from "node:http";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

// A static mirror of a GitHub release page, as `J3_RELEASE_BASE_URL` names one
// for scripts/install.sh and `j3-bots update`: `<base>/latest` and
// `<base>/download/v<version>/<file>`. Its SHA256SUMS are signed with a key
// made for the run, which `J3_RELEASE_PUBLIC_KEY` names to install.sh.

/** A mirror serving `files` by path and noting each path asked for, for the scope. */
export const mirror = (files: ReadonlyMap<string, Uint8Array>) =>
  Effect.acquireRelease(
    Effect.callback<{ readonly url: string; readonly served: Array<string>; close: () => void }>(
      (resume) => {
        const served: Array<string> = [];
        const server = NodeHttp.createServer((request, response) => {
          const path = request.url ?? "/";
          served.push(path);
          const body = files.get(path);
          if (body === undefined) {
            response.writeHead(404).end();
            return;
          }
          response.writeHead(200, { "content-length": body.byteLength });
          response.end(body);
        });
        server.listen(0, "127.0.0.1", () => {
          const address = server.address();
          const port = address !== null && typeof address === "object" ? address.port : 0;
          resume(
            Effect.succeed({
              url: `http://127.0.0.1:${port}`,
              served,
              close: () => server.close(),
            }),
          );
        });
      },
    ),
    (running) => Effect.sync(() => running.close()),
  );

const mirrorKey = NodeCrypto.generateKeyPairSync("ed25519");

/** The public key the mirror signs with, as `J3_RELEASE_PUBLIC_KEY` takes it. */
export const MIRROR_PUBLIC_KEY = mirrorKey.publicKey
  .export({ type: "spki", format: "pem" })
  .toString();

/** SHA256SUMS.sig for `sums`: the Ed25519 signature in base64, one line. */
const signature = (sums: Uint8Array) =>
  encoded(`${NodeCrypto.sign(null, sums, mirrorKey.privateKey).toString("base64")}\n`);

const sha256 = (bytes: Uint8Array) =>
  NodeCrypto.createHash("sha256").update(bytes).digest("hex");

const encoded = (text: string) => new TextEncoder().encode(text);

/** A release archive `pnpm release` built, named in `variable`, and the version its name says. */
export const releaseArchive = Effect.fn("releaseArchive")(function* (variable: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const archive = yield* Config.String(variable);
  const name = path.basename(archive);
  const version = /^j3-bots-(.+)-linux-(x64|arm64)\.tar\.gz$/.exec(name)?.[1];
  if (version === undefined) return yield* Effect.die(`${archive} is not a release archive.`);
  return { name, version, bytes: yield* fs.readFile(archive) };
});

/** One release on a release page, `version`, with its archive and its signed SHA256SUMS. */
export const releaseFiles = (version: string, archive: string, bytes: Uint8Array) => {
  const sums = encoded(`${sha256(bytes)}  ${archive}\n`);
  return new Map<string, Uint8Array>([
    [`/download/v${version}/${archive}`, bytes],
    [`/download/v${version}/SHA256SUMS`, sums],
    [`/download/v${version}/SHA256SUMS.sig`, signature(sums)],
  ]);
};

/** The answer of a release page's `latest`, asked for JSON, when `tag` is the latest release. */
export const latestPage = (tag: string) => encoded(`{"id":1,"tag_name":"${tag}","update_url":"/"}`);
