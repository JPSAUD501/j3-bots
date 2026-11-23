// SPDX-License-Identifier: AGPL-3.0-or-later
// @effect-diagnostics nodeBuiltinImport:off -- signs the fake releases with a key made for the run.
import * as NodeCrypto from "node:crypto";
import { assert, describe, it } from "@effect/vitest";
import { CommandId, type UpdateChannel } from "@j3-bots/contracts";
import type { GitHubRelease } from "@j3-bots/release";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as TestClock from "effect/testing/TestClock";
import { SettingsService } from "../settings/SettingsService.ts";
import * as TestDomain from "../testing/domain.ts";
import { make } from "./ReleaseFeed.ts";

const API = "https://api.test/repos/owner/j3-bots";
const DOWNLOADS = "https://mirror.test/releases";
const key = NodeCrypto.generateKeyPairSync("ed25519");

/** A release's files as the release workflow publishes them. */
interface Published {
  readonly sums: string;
  readonly signature: string | null;
}

const signed = (version: string): Published => {
  const sums = `${"1".repeat(64)}  j3-bots-${version}-linux-x64.tar.gz\n${"2".repeat(64)}  install.sh\n`;
  const signature = NodeCrypto.sign(null, Buffer.from(sums), key.privateKey).toString("base64");
  return { sums, signature: `${signature}\n` };
};

const release = (version: string, prerelease: boolean): GitHubRelease => ({
  tag_name: `v${version}`,
  draft: false,
  prerelease,
  published_at: "2026-11-24T03:17:00Z",
  html_url: `https://github.test/releases/tag/v${version}`,
});

/** The fake releases page and API: what they hold, and what they were asked. */
class FakeGitHub extends Context.Service<
  FakeGitHub,
  {
    latest: GitHubRelease | null;
    listed: Array<GitHubRelease>;
    files: Map<string, Published>;
    /** While set, the API answers 403 with no requests left, until this epoch second. */
    limitedUntil: number | null;
    asked: Array<{ readonly path: string; readonly etag: string | null }>;
  }
>()("@j3-bots/server/releases/ReleaseFeed.test/FakeGitHub") {}

const json = (
  request: Parameters<typeof HttpClientResponse.fromWeb>[0],
  body: unknown,
  etag: string,
) =>
  HttpClientResponse.fromWeb(
    request,
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json", etag },
    }),
  );

const fakeGitHub = Layer.effectContext(
  Effect.sync(() => {
    const github = FakeGitHub.of({
      latest: null,
      listed: [],
      files: new Map(),
      limitedUntil: null,
      asked: [],
    });
    const client = HttpClient.make((request, url) =>
      Effect.sync(() => {
        const etag = request.headers["if-none-match"] ?? null;
        github.asked.push({ path: url.pathname, etag });
        const answer = (body: unknown) => {
          // The ETag names the body, as GitHub's does.
          const tag = `"${NodeCrypto.createHash("sha256").update(JSON.stringify(body)).digest("hex").slice(0, 16)}"`;
          return tag === etag
            ? HttpClientResponse.fromWeb(request, new Response(null, { status: 304 }))
            : json(request, body, tag);
        };
        if (url.origin === new URL(API).origin) {
          if (github.limitedUntil !== null) {
            return HttpClientResponse.fromWeb(
              request,
              new Response("{}", {
                status: 403,
                headers: {
                  "x-ratelimit-remaining": "0",
                  "x-ratelimit-reset": String(github.limitedUntil),
                },
              }),
            );
          }
          if (url.pathname.endsWith("/releases/latest")) {
            return github.latest === null
              ? HttpClientResponse.fromWeb(request, new Response("{}", { status: 404 }))
              : answer(github.latest);
          }
          return answer(github.listed);
        }
        const [, version, name] = /\/download\/v([^/]+)\/(.+)$/.exec(url.pathname) ?? [];
        const files = github.files.get(version ?? "");
        const body =
          name === "SHA256SUMS" ? files?.sums : name === "SHA256SUMS.sig" ? files?.signature : null;
        return HttpClientResponse.fromWeb(
          request,
          body === undefined || body === null
            ? new Response("Not Found", { status: 404 })
            : new Response(body, { status: 200 }),
        );
      }),
    );
    return Context.make(FakeGitHub, github).pipe(Context.add(HttpClient.HttpClient, client));
  }),
);

const config = ConfigProvider.layer(
  ConfigProvider.fromEnvRecord({
    J3_RELEASE_FEED_URL: API,
    J3_RELEASE_BASE_URL: DOWNLOADS,
    J3_RELEASE_PUBLIC_KEY: key.publicKey.export({ type: "spki", format: "pem" }).toString(),
  }),
);

const testLayer = Layer.mergeAll(TestDomain.layer, fakeGitHub, config);

/** Each change of channel is its own command. */
let channelChanges = 0;

const setChannel = (channel: UpdateChannel) =>
  Effect.flatMap(SettingsService, (settings) =>
    settings.update({
      commandId: CommandId.make(`channel-${++channelChanges}`),
      changes: { updateChannel: channel },
    }),
  );

/** The paths the fake was asked for, in order, the ETags left out. */
const asked = Effect.map(FakeGitHub, (github) => github.asked.map((each) => each.path));

describe("the release feed", () => {
  it.effect(
    "offers a newer stable release once its signature verifies, and asks again only with its ETag",
    () =>
      Effect.gen(function* () {
        const github = yield* FakeGitHub;
        github.latest = release("0.3.1", false);
        github.files.set("0.3.1", signed("0.3.1"));
        const feed = yield* make({ running: "0.3.0" });

        const first = yield* feed.check;
        assert.strictEqual(first.available?.version, "0.3.1");
        assert.isTrue(first.available?.verified);
        assert.strictEqual(first.available?.notesUrl, "https://github.test/releases/tag/v0.3.1");
        assert.isNull(first.refused);
        assert.deepStrictEqual(yield* asked, [
          "/repos/owner/j3-bots/releases/latest",
          "/releases/download/v0.3.1/SHA256SUMS",
          "/releases/download/v0.3.1/SHA256SUMS.sig",
        ]);

        // Within a minute, a check repeats the last answer without asking.
        yield* feed.check;
        assert.strictEqual(github.asked.length, 3);

        yield* TestClock.adjust("2 minutes");
        const again = yield* feed.check;
        assert.strictEqual(again.available?.version, "0.3.1");
        // A 304, and the release is not verified twice.
        assert.strictEqual(github.asked.length, 4);
        assert.isNotNull(github.asked[3]?.etag);
      }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("refuses a release whose checksums are not signed by a trusted key", () =>
    Effect.gen(function* () {
      const github = yield* FakeGitHub;
      github.latest = release("0.3.1", false);
      const other = NodeCrypto.generateKeyPairSync("ed25519");
      const { sums } = signed("0.3.1");
      github.files.set("0.3.1", {
        sums,
        signature: NodeCrypto.sign(null, Buffer.from(sums), other.privateKey).toString("base64"),
      });
      const feed = yield* make({ running: "0.3.0" });

      const status = yield* feed.check;
      assert.isNull(status.available);
      assert.deepStrictEqual(status.refused, { version: "0.3.1", reason: "signature-invalid" });

      github.files.set("0.3.1", { sums, signature: null });
      github.latest = release("0.3.2", false);
      github.files.set("0.3.2", { sums: signed("0.3.2").sums, signature: null });
      yield* TestClock.adjust("2 minutes");
      assert.deepStrictEqual((yield* feed.check).refused, {
        version: "0.3.2",
        reason: "signature-missing",
      });
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect(
    "never offers the release that runs or an older one, and downloads nothing for it",
    () =>
      Effect.gen(function* () {
        const github = yield* FakeGitHub;
        github.latest = release("0.3.1", false);
        github.files.set("0.3.1", signed("0.3.1"));
        const feed = yield* make({ running: "0.3.1" });

        const status = yield* feed.check;
        assert.isNull(status.available);
        assert.isFalse(status.waitingForStable);
        assert.deepStrictEqual(yield* asked, ["/repos/owner/j3-bots/releases/latest"]);
      }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("waits out a rate limit, keeping what it found before", () =>
    Effect.gen(function* () {
      const github = yield* FakeGitHub;
      github.latest = release("0.3.1", false);
      github.files.set("0.3.1", signed("0.3.1"));
      const feed = yield* make({ running: "0.3.0" });
      yield* feed.check;

      yield* TestClock.adjust("2 minutes");
      // Reset in an hour.
      github.limitedUntil = 2 * 60 + 60 * 60;
      const limited = yield* feed.check;
      assert.strictEqual(limited.lastCheck?.failure, "rate-limited");
      assert.strictEqual(limited.lastCheck?.nextAt.epochMilliseconds, github.limitedUntil * 1000);
      assert.strictEqual(limited.available?.version, "0.3.1");

      // Nothing is asked on its own before the reset.
      const before = github.asked.length;
      yield* TestClock.adjust("59 minutes");
      assert.strictEqual(github.asked.length, before);
      github.limitedUntil = null;
      yield* TestClock.adjust("90 seconds");
      // Waits for the check under way, which answered within the minute.
      assert.isNull((yield* feed.check).lastCheck?.failure);
      assert.strictEqual(github.asked.length, before + 1);
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect(
    "offers nightly its newest prerelease, and after a move to stable waits for a newer stable release",
    () =>
      Effect.gen(function* () {
        const github = yield* FakeGitHub;
        const running = "0.3.2-nightly.20261124.1";
        github.listed = [
          release("0.3.2-nightly.20261126.1", true),
          release("0.3.2-nightly.20261125.4", true),
          release("0.3.2-rc.1", true),
          release("0.3.1", false),
        ];
        github.latest = release("0.3.1", false);
        for (const version of ["0.3.2-nightly.20261126.1", "0.3.2"]) {
          github.files.set(version, signed(version));
        }
        yield* setChannel("nightly");
        const feed = yield* make({ running });

        const nightly = yield* feed.check;
        assert.strictEqual(nightly.channel, "nightly");
        assert.deepStrictEqual(nightly.current, { version: running, channel: "nightly" });
        assert.strictEqual(nightly.available?.version, "0.3.2-nightly.20261126.1");
        assert.strictEqual(nightly.available?.channel, "nightly");

        yield* setChannel("stable");
        const stable = yield* feed.check;
        assert.strictEqual(stable.channel, "stable");
        assert.isNull(stable.available);
        assert.isTrue(stable.waitingForStable);

        github.latest = release("0.3.2", false);
        yield* TestClock.adjust("2 minutes");
        const released = yield* feed.check;
        assert.strictEqual(released.available?.version, "0.3.2");
        assert.isFalse(released.waitingForStable);
      }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("checks a minute after it starts, then keeps what it found through a restart", () =>
    Effect.gen(function* () {
      const github = yield* FakeGitHub;
      github.latest = release("0.3.1", false);
      github.files.set("0.3.1", signed("0.3.1"));

      yield* Effect.gen(function* () {
        const feed = yield* make({ running: "0.3.0" });
        yield* TestClock.adjust("59 seconds");
        assert.strictEqual(github.asked.length, 0);
        yield* TestClock.adjust("2 seconds");
        // Waits for the check under way, which answered within the minute.
        yield* feed.check;
        assert.strictEqual(github.asked.length, 3);
      }).pipe(Effect.scoped);

      const restarted = yield* make({ running: "0.3.0" });
      yield* TestClock.adjust("5 minutes");
      assert.strictEqual(github.asked.length, 3);
      const status = yield* restarted.status;
      assert.strictEqual(status.available?.version, "0.3.1");
      assert.isNotNull(status.lastCheck);
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );
});
