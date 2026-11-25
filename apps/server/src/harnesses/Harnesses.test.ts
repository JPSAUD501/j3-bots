// SPDX-License-Identifier: AGPL-3.0-or-later
// @effect-diagnostics nodeBuiltinImport:off -- A test's Codex package is a gzipped tar, made here with Node's zlib.
import * as NodeZlib from "node:zlib";
import { assert, describe, it } from "@effect/vitest";
import { type HarnessCopy, ProviderId, type SignInHarness } from "@j3-bots/contracts";
import { TestEngineControl } from "@j3-bots/engine-t3/testing";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as TestClock from "effect/testing/TestClock";
import { ServerConfig } from "../config.ts";
import * as TestDomain from "../testing/domain.ts";
import { claudeCode, codex, onlyTo } from "./distributions.ts";
import { type Harnesses, make, withCopies } from "./Harnesses.ts";
import { sha256Hex } from "./hash.ts";
import { versionIn } from "./install.ts";
import { copyLayout } from "./layout.ts";

const CLAUDE_BASE = "https://downloads.test/claude-code-releases";
const CODEX_BASE = "https://releases.test/codex";
const MACHINE = { platform: "linux", arch: "x64" } as const;
const CODEX_PACKAGE = "codex-package-x86_64-unknown-linux-musl.tar.gz";

const bytes = (text: string) => new TextEncoder().encode(text);

/** What a fake Claude Code binary of `version` holds: what the probe reads as its `--version`. */
const claudeBinary = (version: string) => bytes(`${"#".repeat(4096)}\n${version} (Claude Code)\n`);

/** A tar archive of `entries` (a folder when its content is null), gzipped. */
const tarGz = (entries: ReadonlyArray<readonly [string, Uint8Array | null]>): Uint8Array => {
  const blocks: Array<Uint8Array> = [];
  for (const [name, content] of entries) {
    const header = new Uint8Array(512);
    const put = (offset: number, text: string) => header.set(bytes(text), offset);
    const octal = (value: number, width: number) =>
      `${value.toString(8).padStart(width - 1, "0")}\0`;
    put(0, name);
    put(100, octal(0o755, 8));
    put(108, octal(0, 8));
    put(116, octal(0, 8));
    put(124, octal(content?.byteLength ?? 0, 12));
    put(136, octal(0, 12));
    put(148, "        ");
    put(156, content === null ? "5" : "0");
    put(257, "ustar\0");
    put(263, "00");
    const sum = header.reduce((total, byte) => total + byte, 0);
    put(148, `${sum.toString(8).padStart(6, "0")}\0 `);
    blocks.push(header);
    if (content !== null) {
      const padded = new Uint8Array(Math.ceil(content.byteLength / 512) * 512);
      padded.set(content);
      blocks.push(padded);
    }
  }
  blocks.push(new Uint8Array(1024));
  const tar = new Uint8Array(blocks.reduce((total, block) => total + block.byteLength, 0));
  let offset = 0;
  for (const block of blocks) {
    tar.set(block, offset);
    offset += block.byteLength;
  }
  return new Uint8Array(NodeZlib.gzipSync(tar));
};

/** How the fake answers one file: whole, cut off after some bytes, or never finished. */
type Serving =
  | { readonly _tag: "whole" }
  | { readonly _tag: "cut"; readonly after: number }
  | { readonly _tag: "hang"; readonly after: number };

interface FakeDistributions {
  readonly files: Map<string, Uint8Array>;
  readonly serving: Map<string, Serving>;
  /** Each request, by path, with the range it asked for. */
  readonly asked: Array<{ readonly path: string; readonly range: string | null }>;
}

const fakeClient = (fake: FakeDistributions) =>
  HttpClient.make((request, url) =>
    Effect.sync(() => {
      const range = request.headers["range"] ?? null;
      fake.asked.push({ path: url.pathname, range });
      const file = fake.files.get(url.pathname);
      if (file === undefined) {
        return HttpClientResponse.fromWeb(request, new Response(null, { status: 404 }));
      }
      const from = range === null ? 0 : Number(/^bytes=(\d+)-$/.exec(range)?.[1] ?? 0);
      if (from >= file.byteLength && range !== null) {
        return HttpClientResponse.fromWeb(request, new Response(null, { status: 416 }));
      }
      const rest = file.slice(from);
      const serving = fake.serving.get(url.pathname) ?? { _tag: "whole" };
      // Served once as asked: a cut or a hang applies to one request.
      fake.serving.delete(url.pathname);
      // The first bytes arrive; then the connection resets, or nothing more comes.
      const body =
        serving._tag === "whole"
          ? rest
          : new ReadableStream<Uint8Array>({
              start: (controller) => controller.enqueue(rest.slice(0, serving.after)),
              pull: (controller) =>
                serving._tag === "cut"
                  ? controller.error(new Error("connection reset"))
                  : new Promise<void>(() => {}),
            });
      return HttpClientResponse.fromWeb(
        request,
        new Response(body, {
          status: range === null ? 200 : 206,
          headers: serving._tag === "whole" ? { "content-length": String(rest.byteLength) } : {},
        }),
      );
    }),
  );

/** Puts Claude Code `version` on the fake's stable channel, whose binary hashes to `digest` if given. */
const publishClaude = (
  fake: FakeDistributions,
  version: string,
  binary: Uint8Array = claudeBinary(version),
  digest: string = sha256Hex(binary),
) => {
  fake.files.set("/claude-code-releases/stable", bytes(`${version}\n`));
  fake.files.set(
    `/claude-code-releases/${version}/manifest.json`,
    bytes(
      JSON.stringify({
        version,
        platforms: { "linux-x64": { binary: "claude", checksum: digest, size: binary.byteLength } },
      }),
    ),
  );
  fake.files.set(`/claude-code-releases/${version}/linux-x64/claude`, binary);
};

/** Puts Codex `version` on the fake's latest channel, as a package whose entrypoint says it. */
const publishCodex = (fake: FakeDistributions, version: string) => {
  const archive = tarGz([
    [
      "codex-package.json",
      bytes(JSON.stringify({ layoutVersion: 1, version, entrypoint: "bin/codex" })),
    ],
    ["bin/", null],
    ["bin/codex", bytes(`codex-cli ${version}\n`)],
  ]);
  const sums = bytes(`${sha256Hex(archive)}  ${CODEX_PACKAGE}\n`);
  fake.files.set(
    "/codex/channels/latest",
    bytes(
      JSON.stringify({
        tag_name: `rust-v${version}`,
        assets: [
          { name: CODEX_PACKAGE, digest: `sha256:${sha256Hex(archive)}` },
          { name: "codex-package_SHA256SUMS", digest: `sha256:${sha256Hex(sums)}` },
        ],
      }),
    ),
  );
  fake.files.set(`/codex/releases/${version}/codex-package_SHA256SUMS`, sums);
  fake.files.set(`/codex/releases/${version}/${CODEX_PACKAGE}`, archive);
};

interface Setup {
  readonly harnesses: Harnesses["Service"];
  readonly fake: FakeDistributions;
  readonly home: string;
  /** How many bots on each provider have work running, as the switch sees it. */
  readonly running: Ref.Ref<number>;
}

/**
 * The service over the test domain's home, with fake distributions of both
 * harnesses, a probe that reads what a fake binary says it is, and the
 * operator's own on `PATH` as `onPath` says.
 */
const setup = Effect.fn(function* (options?: {
  readonly onPath?: ReadonlyArray<SignInHarness>;
  readonly prepare?: (fake: FakeDistributions) => void;
}) {
  const fs = yield* FileSystem.FileSystem;
  const { home } = yield* ServerConfig;
  const fake: FakeDistributions = { files: new Map(), serving: new Map(), asked: [] };
  options?.prepare?.(fake);
  const client = onlyTo(["https://downloads.test", "https://releases.test"])(fakeClient(fake));
  const running = yield* Ref.make(0);
  const harnesses = yield* make({
    home,
    platform: MACHINE.platform,
    distributions: {
      "claude-code": claudeCode(client, CLAUDE_BASE, MACHINE),
      codex: codex(client, CODEX_BASE, MACHINE),
    },
    probe: () => (executable) =>
      fs.readFileString(executable).pipe(Effect.map(versionIn), Effect.orElseSucceed(Option.none)),
    onPath: (harness) => Effect.succeed(options?.onPath?.includes(harness) ?? false),
    autoUpdate: Stream.make(true),
    work: {
      paused: (effect) => effect,
      running: () => Ref.get(running),
    },
  });
  return { harnesses, fake, home, running } satisfies Setup;
});

/** The first state of `harness`'s copy that `until` holds for. */
const copyWhen = (
  harnesses: Harnesses["Service"],
  harness: SignInHarness,
  until: (copy: HarnessCopy) => boolean,
) =>
  harnesses.copies.pipe(
    Stream.map((copies) => copies[harness]),
    Stream.filter(until),
    Stream.runHead,
    Effect.map(Option.getOrThrow),
  );

const ended = (copy: HarnessCopy) => copy.task === null && copy.last !== null;

/** Whether the last install ended with `version` installed. */
const installed = (version: string) => (copy: HarnessCopy) =>
  ended(copy) && copy.last?._tag === "installed" && copy.last.version === version;

/** Each executable the engine's providers were switched to, in order. */
const switchedTo = Effect.flatMap(TestEngineControl, (control) => control.harnessExecutables);

describe("J3 Bots' own copies of the harnesses", () => {
  it.effect("installs Claude Code from its manifest, and runs the engine's provider on it", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const fs = yield* FileSystem.FileSystem;
      const { harnesses, home } = yield* setup({
        prepare: (fake) => publishClaude(fake, "2.1.326"),
      });

      yield* harnesses.install("claude-code");
      const copy = yield* copyWhen(harnesses, "claude-code", ended);
      assert.strictEqual(copy.source, "j3");
      assert.strictEqual(copy.version, "2.1.326");
      assert.strictEqual(copy.last?._tag, "installed");

      const layout = copyLayout(path, home, "claude-code");
      const executable = path.join(layout.version("2.1.326"), "claude");
      assert.deepStrictEqual(yield* switchedTo, [
        { providerId: ProviderId.make("claude-code"), executable },
      ]);
      assert.deepStrictEqual(JSON.parse(yield* fs.readFileString(layout.current)), {
        version: "2.1.326",
        executable: "claude",
      });
    }).pipe(Effect.scoped, Effect.provide(TestDomain.layer)),
  );

  it.effect("installs Codex from its package, checked against the listing and its SHA256SUMS", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const { harnesses, home } = yield* setup({
        prepare: (fake) => publishCodex(fake, "0.172.0"),
      });

      yield* harnesses.install("codex");
      const copy = yield* copyWhen(harnesses, "codex", ended);
      assert.strictEqual(copy.last?._tag, "installed");
      assert.deepStrictEqual(yield* switchedTo, [
        {
          providerId: ProviderId.make("codex"),
          executable: path.join(copyLayout(path, home, "codex").version("0.172.0"), "bin", "codex"),
        },
      ]);
    }).pipe(Effect.scoped, Effect.provide(TestDomain.layer)),
  );

  it.effect("refuses a download whose SHA-256 is not the manifest's, and keeps nothing of it", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const fs = yield* FileSystem.FileSystem;
      const { harnesses, home } = yield* setup({
        prepare: (fake) => publishClaude(fake, "2.1.326", claudeBinary("2.1.326"), "0".repeat(64)),
      });

      yield* harnesses.install("claude-code");
      const copy = yield* copyWhen(harnesses, "claude-code", ended);
      assert.deepStrictEqual(copy.last?._tag === "failed" ? copy.last.reason : null, "checksum");
      assert.strictEqual(copy.source, "none");
      assert.deepStrictEqual(yield* switchedTo, []);
      const layout = copyLayout(path, home, "claude-code");
      assert.isFalse(yield* fs.exists(layout.partial("2.1.326")));
      assert.isFalse(yield* fs.exists(layout.version("2.1.326")));
    }).pipe(Effect.scoped, Effect.provide(TestDomain.layer)),
  );

  it.effect("resumes a download that was cut off from where it stopped", () =>
    Effect.gen(function* () {
      const { harnesses, fake } = yield* setup({
        prepare: (fake) => {
          publishClaude(fake, "2.1.326");
          fake.serving.set("/claude-code-releases/2.1.326/linux-x64/claude", {
            _tag: "cut",
            after: 1000,
          });
        },
      });

      yield* harnesses.install("claude-code");
      const cut = yield* copyWhen(harnesses, "claude-code", ended);
      assert.deepStrictEqual(cut.last?._tag === "failed" ? cut.last.reason : null, "unreachable");

      yield* harnesses.install("claude-code");
      const resumed = yield* copyWhen(harnesses, "claude-code", installed("2.1.326"));
      assert.strictEqual(resumed.version, "2.1.326");
      const downloads = fake.asked.filter(({ path }) => path.endsWith("/linux-x64/claude"));
      assert.deepStrictEqual(
        downloads.map(({ range }) => range),
        [null, "bytes=1000-"],
      );
    }).pipe(Effect.scoped, Effect.provide(TestDomain.layer)),
  );

  it.effect("stops an install a client cancels, and drops what it downloaded", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const fs = yield* FileSystem.FileSystem;
      const { harnesses, home } = yield* setup({
        prepare: (fake) => {
          publishClaude(fake, "2.1.326");
          fake.serving.set("/claude-code-releases/2.1.326/linux-x64/claude", {
            _tag: "hang",
            after: 1000,
          });
        },
      });

      yield* harnesses.install("claude-code");
      const downloading = yield* copyWhen(
        harnesses,
        "claude-code",
        (copy) => copy.task?._tag === "downloading" && copy.task.receivedBytes > 0,
      );
      assert.strictEqual(downloading.source, "none");
      yield* harnesses.cancel("claude-code");
      const copy = yield* copyWhen(harnesses, "claude-code", ended);
      assert.strictEqual(copy.last?._tag, "cancelled");
      assert.deepStrictEqual(yield* switchedTo, []);
      assert.isFalse(yield* fs.exists(copyLayout(path, home, "claude-code").partial("2.1.326")));
    }).pipe(Effect.scoped, Effect.provide(TestDomain.layer)),
  );

  it.effect(
    "keeps the version it runs when a newer one does not say it is that version, and replaces it once one does",
    () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const fs = yield* FileSystem.FileSystem;
        const { harnesses, fake, home } = yield* setup({
          prepare: (fake) => publishClaude(fake, "2.1.326"),
        });
        const layout = copyLayout(path, home, "claude-code");
        yield* harnesses.install("claude-code");
        yield* copyWhen(harnesses, "claude-code", installed("2.1.326"));

        // A binary that hashes as listed, but runs as another version.
        publishClaude(fake, "2.1.330", claudeBinary("2.1.329"));
        yield* harnesses.install("claude-code");
        const refused = yield* copyWhen(
          harnesses,
          "claude-code",
          (copy) => ended(copy) && copy.last?._tag === "failed",
        );
        assert.deepStrictEqual(
          refused.last?._tag === "failed" ? refused.last.reason : null,
          "check",
        );
        assert.strictEqual(refused.version, "2.1.326");
        assert.isTrue(yield* fs.exists(path.join(layout.version("2.1.326"), "claude")));
        assert.isFalse(yield* fs.exists(layout.version("2.1.330")));

        publishClaude(fake, "2.1.330");
        yield* harnesses.install("claude-code");
        const updated = yield* copyWhen(harnesses, "claude-code", installed("2.1.330"));
        assert.strictEqual(updated.last?._tag, "installed");
        assert.deepStrictEqual(
          (yield* switchedTo).map(({ executable }) => executable),
          [
            path.join(layout.version("2.1.326"), "claude"),
            path.join(layout.version("2.1.330"), "claude"),
          ],
        );
        assert.deepStrictEqual(yield* fs.readDirectory(layout.versions), ["2.1.330"]);
      }).pipe(Effect.scoped, Effect.provide(TestDomain.layer)),
  );

  it.effect("updates on its own at its check, once no bot on the provider has work running", () =>
    Effect.gen(function* () {
      const { harnesses, fake, running } = yield* setup({
        prepare: (fake) => publishClaude(fake, "2.1.326"),
      });
      yield* harnesses.install("claude-code");
      yield* copyWhen(harnesses, "claude-code", installed("2.1.326"));

      publishClaude(fake, "2.1.330");
      yield* Ref.set(running, 1);
      // The first check, a minute after the start.
      yield* TestClock.adjust("1 minute");
      const waiting = yield* copyWhen(
        harnesses,
        "claude-code",
        (copy) => copy.task?._tag === "waiting",
      );
      assert.strictEqual(waiting.version, "2.1.326");
      assert.strictEqual(waiting.latest, "2.1.330");
      assert.lengthOf(yield* switchedTo, 1);

      // Still running at the next look: it waits on.
      yield* TestClock.adjust("30 seconds");
      assert.lengthOf(yield* switchedTo, 1);

      yield* Ref.set(running, 0);
      yield* TestClock.adjust("30 seconds");
      const updated = yield* copyWhen(harnesses, "claude-code", installed("2.1.330"));
      assert.isNull(updated.task);
      assert.lengthOf(yield* switchedTo, 2);
    }).pipe(Effect.scoped, Effect.provide(TestDomain.layer)),
  );

  it.effect(
    "leaves a harness the operator installed alone: no install, and no check of its maker",
    () =>
      Effect.gen(function* () {
        const { harnesses, fake } = yield* setup({
          onPath: ["claude-code"],
          prepare: (fake) => publishClaude(fake, "2.1.326"),
        });
        const copy = yield* copyWhen(harnesses, "claude-code", () => true);
        assert.strictEqual(copy.source, "operator");

        const refused = yield* Effect.flip(harnesses.install("claude-code"));
        assert.strictEqual(refused.reason, "harness-not-installable");
        yield* TestClock.adjust("1 minute");
        assert.deepStrictEqual(
          fake.asked.filter(({ path }) => path.startsWith("/claude-code-releases")),
          [],
        );
        assert.deepStrictEqual(yield* switchedTo, []);
      }).pipe(Effect.scoped, Effect.provide(TestDomain.layer)),
  );

  it("keeps the engine's update off J3 Bots' own copy, and offers it for the operator's", () => {
    const provider = {
      id: ProviderId.make("claude-code"),
      name: "Claude Code",
      harness: "claude-code",
      status: { _tag: "ready" },
      models: [],
      usage: [],
      version: { installed: "2.1.300", latest: "2.1.330", canUpdate: true },
    } as const;
    const copy = (source: HarnessCopy["source"]): HarnessCopy => ({
      source,
      version: source === "j3" ? "2.1.300" : null,
      latest: "2.1.330",
      installable: true,
      task: null,
      last: null,
    });
    const served = (source: HarnessCopy["source"]) =>
      withCopies(
        { state: { _tag: "ready" }, pinnedVersion: "0.7.1", providers: [provider] },
        { "claude-code": copy(source), codex: copy("none") },
      ).providers[0];
    // The engine would run Claude Code's own updater on J3 Bots' copy.
    assert.isUndefined(served("j3")?.version);
    assert.deepStrictEqual(served("operator")?.version, provider.version);
  });
});
