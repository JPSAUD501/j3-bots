// SPDX-License-Identifier: AGPL-3.0-or-later
import { assert, describe, it } from "@effect/vitest";
import { SIGNATURE_FILE, SUMS_FILE } from "@j3-bots/release";
import { sha256, signatureCheck } from "@j3-bots/release/node";
import {
  TEST_FILES,
  TEST_PUBLIC_KEY,
  TEST_VERSION,
  VERIFICATION_CASES,
  type VerificationCase,
} from "@j3-bots/release/testing";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import {
  type DownloadCheckPorts,
  type DownloadRefusal,
  installableName,
  RELEASE_FILES_WITHIN,
  verifyDownload,
} from "./downloadCheck.ts";

const bytes = (text: string) => new TextEncoder().encode(text);
const digest = (text: string) => {
  const hash = sha256();
  hash.update(bytes(text));
  return hash.hex();
};

const check = signatureCheck([{ id: "test", pem: TEST_PUBLIC_KEY }]);
const CACHE = "/cache/j3-bots-updater/pending";

/** A release that publishes `sums` and `signature`, and a download whose contents are `contents`. */
const ports = (
  release: { readonly sums: string | null; readonly signature: string | null },
  contents: string,
  platform: NodeJS.Platform,
): DownloadCheckPorts => ({
  releaseFile: (_version, name) => {
    const text =
      name === SUMS_FILE ? release.sums : name === SIGNATURE_FILE ? release.signature : null;
    return Promise.resolve(text === null ? null : bytes(text));
  },
  sha256File: () => Promise.resolve(digest(contents)),
  check,
  platform,
});

const outcome = (
  download: { readonly file: string; readonly version: string },
  surroundings: DownloadCheckPorts,
): Effect.Effect<"verified" | DownloadRefusal> =>
  verifyDownload(download, surroundings).pipe(
    Effect.as("verified" as const),
    Effect.catchTag("DownloadRefused", (refused) => Effect.succeed(refused.reason)),
  );

/** The platform that installs a case's file, if any does: an installer on Windows, everything else on Linux. */
const platformOf = (name: string): NodeJS.Platform => (name.endsWith(".exe") ? "win32" : "linux");

/**
 * What the app ends with for a case: the list's own verdict when the list is
 * refused, as nothing about the file is looked at before it is trusted; a
 * file this platform does not install refused as such; the case's end otherwise.
 */
const expected = (testCase: VerificationCase): "verified" | DownloadRefusal => {
  switch (testCase.expect) {
    case "verified":
    case "entry-missing":
    case "digest-mismatch":
      return installableName(testCase.file.name, platformOf(testCase.file.name)) === null
        ? "not-installable"
        : testCase.expect;
    default:
      return testCase.expect;
  }
};

describe("checking a download against the release's signed checksums", () => {
  for (const testCase of VERIFICATION_CASES) {
    it.effect(`ends ${expected(testCase)} for ${testCase.name}`, () =>
      Effect.gen(function* () {
        const platform = platformOf(testCase.file.name);
        const result = yield* outcome(
          { file: `${CACHE}/${testCase.file.name}`, version: testCase.version },
          ports(testCase, testCase.file.contents, platform),
        );
        assert.strictEqual(result, expected(testCase));
      }),
    );
  }

  const [good] = VERIFICATION_CASES;
  const appImage = "J3-Bots-x64.AppImage";

  it.effect("refuses a release without SHA256SUMS", () =>
    Effect.gen(function* () {
      assert.isDefined(good);
      const result = yield* outcome(
        { file: `${CACHE}/${appImage}`, version: TEST_VERSION },
        ports({ sums: null, signature: good.signature }, TEST_FILES[appImage] ?? "", "linux"),
      );
      assert.strictEqual(result, "checksums-missing");
    }),
  );

  it.effect("refuses a file the release signs but this platform does not install", () =>
    Effect.gen(function* () {
      assert.isDefined(good);
      const result = yield* outcome(
        { file: `${CACHE}/install.sh`, version: TEST_VERSION },
        ports(good, TEST_FILES["install.sh"] ?? "", "linux"),
      );
      assert.strictEqual(result, "not-installable");
    }),
  );

  it.effect("refuses when the release cannot be reached or the file cannot be read", () =>
    Effect.gen(function* () {
      assert.isDefined(good);
      const download = { file: `${CACHE}/${appImage}`, version: TEST_VERSION };
      const healthy = ports(good, TEST_FILES[appImage] ?? "", "linux");
      const offline = yield* outcome(download, {
        ...healthy,
        releaseFile: () => Promise.reject(new Error("offline")),
      });
      const gone = yield* outcome(download, {
        ...healthy,
        sha256File: () => Promise.reject(new Error("ENOENT")),
      });
      assert.deepStrictEqual([offline, gone], ["unreadable", "unreadable"]);
    }),
  );

  it.effect("refuses, and stops asking, when the release does not answer in time", () =>
    Effect.gen(function* () {
      assert.isDefined(good);
      const asked: Array<AbortSignal> = [];
      const fiber = yield* outcome(
        { file: `${CACHE}/${appImage}`, version: TEST_VERSION },
        {
          ...ports(good, TEST_FILES[appImage] ?? "", "linux"),
          releaseFile: (_version, _name, signal) => {
            asked.push(signal);
            return new Promise(() => {});
          },
        },
      ).pipe(Effect.forkChild);
      yield* TestClock.adjust(RELEASE_FILES_WITHIN);
      assert.strictEqual(yield* Fiber.join(fiber), "unreadable");
      assert.isTrue(asked.length > 0 && asked.every((signal) => signal.aborted));
    }),
  );
});

describe("the file a platform installs", () => {
  it("is an AppImage on Linux and an installer on Windows, by the cache's file name", () => {
    assert.strictEqual(
      installableName("/cache/pending/J3-Bots-x64.AppImage", "linux"),
      "J3-Bots-x64.AppImage",
    );
    assert.strictEqual(
      installableName("C:\\cache\\pending\\J3-Bots-Setup-0.4.0-unsigned.exe", "win32"),
      "J3-Bots-Setup-0.4.0-unsigned.exe",
    );
    assert.isNull(installableName("/cache/pending/J3-Bots-x64.AppImage", "win32"));
    assert.isNull(installableName("/cache/pending/J3-Bots-Setup.exe", "linux"));
    assert.isNull(installableName("/cache/pending/.AppImage", "linux"));
    assert.isNull(installableName("/cache/pending/J3-Bots.dmg", "darwin"));
  });
});
