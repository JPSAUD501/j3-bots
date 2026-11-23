// SPDX-License-Identifier: AGPL-3.0-or-later
// @effect-diagnostics nodeBuiltinImport:off -- the test signs its release with node:crypto, as the release workflow does.
import * as NodeCrypto from "node:crypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { signatureCheck } from "@j3-bots/release/node";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { RELEASE_MANIFEST } from "../installation.ts";
import { fetchRelease } from "./release.ts";

const VERSION = "9.0.0";
const PLATFORM = "linux-x64";
const STEM = `j3-bots-${VERSION}-${PLATFORM}`;
const ARCHIVE = `${STEM}.tar.gz`;
/** Where releases are downloaded from when no mirror is set. */
const DOWNLOADS = `https://github.com/JPSAUD501/j3-bots/releases/download/v${VERSION}`;

const { publicKey, privateKey } = NodeCrypto.generateKeyPairSync("ed25519");
const check = signatureCheck([
  { id: "test", pem: publicKey.export({ type: "spki", format: "pem" }).toString() },
]);

/** A release folder's files: its manifest, a launcher that answers `--version`, and `mark`. */
const writeRelease = (folder: string, mark: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* fs.makeDirectory(path.join(folder, "bin"), { recursive: true });
    yield* fs.writeFileString(
      path.join(folder, RELEASE_MANIFEST),
      JSON.stringify({ version: VERSION, platform: PLATFORM, node: "24.0.0" }),
    );
    yield* fs.writeFileString(path.join(folder, "bin", "j3-bots"), "#!/bin/sh\nexit 0\n", {
      mode: 0o755,
    });
    yield* fs.writeFileString(path.join(folder, "mark"), mark);
  });

/** The signed release's archive, `SHA256SUMS` and signature, as its releases page serves them. */
const publish = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const work = yield* fs.makeTempDirectoryScoped({ prefix: "j3-release-" });
  yield* writeRelease(path.join(work, STEM), "signed");
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const tar = yield* spawner.exitCode(
    ChildProcess.make("tar", ["-czf", ARCHIVE, STEM], { cwd: work, stdin: "ignore" }),
  );
  assert.strictEqual(tar, 0);
  const archive = yield* fs.readFile(path.join(work, ARCHIVE));
  const digest = NodeCrypto.createHash("sha256").update(archive).digest("hex");
  const sums = new TextEncoder().encode(`${digest}  ${ARCHIVE}\n`);
  const signature = new TextEncoder().encode(
    `${NodeCrypto.sign(null, sums, privateKey).toString("base64")}\n`,
  );
  return new Map<string, Uint8Array>([
    [`${DOWNLOADS}/${ARCHIVE}`, archive],
    [`${DOWNLOADS}/SHA256SUMS`, sums],
    [`${DOWNLOADS}/SHA256SUMS.sig`, signature],
  ]);
});

/** A releases page that serves `files` by URL, and 404 for anything else. */
const releasesPage = (files: ReadonlyMap<string, Uint8Array>) =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          new Response(files.get(request.url) ?? null, {
            status: files.has(request.url) ? 200 : 404,
          }),
        ),
      ),
    ),
  );

/** `fetchRelease` into `install` from a page serving `files`. */
const fetchInto = (install: string, files: ReadonlyMap<string, Uint8Array>, provenOnly: boolean) =>
  fetchRelease({
    install,
    version: VERSION,
    platform: PLATFORM,
    check,
    progress: () => Effect.void,
    provenOnly,
  }).pipe(Effect.provide(releasesPage(files)));

/** The mark of the release in `install`. */
const markIn = (install: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    return yield* fs.readFileString(path.join(install, "versions", VERSION, "mark"));
  });

it.layer(NodeServices.layer)("a release fetched for an update", (it) => {
  it.effect("is installed only once its checksums carry a trusted signature", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const files = yield* publish;
      const unsigned = new Map(files);
      unsigned.delete(`${DOWNLOADS}/SHA256SUMS.sig`);
      const install = yield* fs.makeTempDirectoryScoped({ prefix: "j3-install-" });
      const refused = yield* fetchInto(install, unsigned, true).pipe(Effect.exit);
      assert.isTrue(Exit.isFailure(refused));
      assert.deepInclude(Option.getOrUndefined(Exit.findErrorOption(refused)), {
        reason: "unsigned",
      });
      assert.isFalse(yield* fs.exists(path.join(install, "versions", VERSION)));

      const installed = yield* fetchInto(install, files, true);
      assert.isFalse(installed.alreadyThere);
      assert.strictEqual(yield* markIn(install), "signed");
    }),
  );

  it.effect(
    "for a client takes a release already there only when it is proven the signed one",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const files = yield* publish;
        const install = yield* fs.makeTempDirectoryScoped({ prefix: "j3-install-" });
        // Left by a mirror, or by an install that verified nothing.
        yield* writeRelease(path.join(install, "versions", VERSION), "unproven");

        // An operator's own update keeps it, as before.
        assert.isTrue((yield* fetchInto(install, files, false)).alreadyThere);
        assert.strictEqual(yield* markIn(install), "unproven");

        const replaced = yield* fetchInto(install, files, true);
        assert.isFalse(replaced.alreadyThere);
        assert.strictEqual(yield* markIn(install), "signed");

        // Now proven: taken as it is.
        assert.isTrue((yield* fetchInto(install, files, true)).alreadyThere);
      }),
  );
});
