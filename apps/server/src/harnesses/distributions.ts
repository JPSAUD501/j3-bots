// SPDX-License-Identifier: AGPL-3.0-or-later
import { HarnessVersion, type SignInHarness } from "@j3-bots/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Duration from "effect/Duration";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import type * as HttpClientError from "effect/http/HttpClientError";
import type * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Stream from "effect/Stream";
import { HarnessFailed } from "./failure.ts";
import { sha256Hex } from "./hash.ts";

// Where J3 Bots' own copies of the harnesses come from: each maker's official
// distribution, read as its own install scripts read it, over HTTPS, from the
// maker's origin only and following no redirect
// (docs/decisions/0045-j3-bots-keeps-its-own-copies-of-the-harnesses.md).
//
// Claude Code (**Verified** 2026-11-25 against `downloads.claude.ai`, as
// Anthropic's `bootstrap.sh` and `bootstrap.ps1` read it):
//   <base>/stable                        the stable channel's version, as text
//   <base>/<version>/manifest.json       each platform's binary, size and SHA-256
//   <base>/<version>/<platform>/claude   the binary (`claude.exe` on Windows)
//
// Codex (**Verified** 2026-11-25 against `releases.openai.com`, as OpenAI's
// `install.sh` and `install.ps1` read it):
//   <base>/channels/latest                         the latest release: its tag and each asset's SHA-256
//   <base>/releases/<version>/codex-package_SHA256SUMS
//   <base>/releases/<version>/codex-package-<target>.tar.gz
// The package's digest is the listing's, and the `SHA256SUMS` file, checked
// against the listing's digest for it, must say the same.

/** The origin and path every Claude Code file is read under. */
const CLAUDE_CODE_BASE = "https://downloads.claude.ai/claude-code-releases";
/** The origin and path every Codex file is read under. */
const CODEX_BASE = "https://releases.openai.com/codex";

/** How a release's download is installed: one executable file, or a gzipped tar to unpack. */
type ReleaseFormat = "executable" | "tar.gz";

/** One release of a harness, for this machine, with what its download must hash to. */
export interface Release {
  readonly version: HarnessVersion;
  readonly url: string;
  /** Lowercase hex SHA-256 of the whole download, as the maker publishes it. */
  readonly sha256: string;
  /** The download's size, when the maker publishes it. */
  readonly size: number | null;
  readonly format: ReleaseFormat;
  /** For `executable`, the name the file is saved under in its version's folder. */
  readonly fileName: string;
}

/** Where a harness is downloaded from, and what its maker ships for this machine. */
export interface Distribution {
  /** The origin a download of this harness may be read from; nothing else is. */
  readonly origin: string;
  /** Whether the maker ships a build J3 Bots installs for this system and processor. */
  readonly installable: boolean;
  /** The newest release for this machine, as the maker lists it now. */
  readonly latest: Effect.Effect<Release, HarnessFailed>;
  /** The client a release's download is read through: to `origin` only, following no redirect. */
  readonly client: DistributionClient;
}

/** No listing, manifest or checksum file is near this. */
const MAX_LISTING_BYTES = 2 * 1024 * 1024;
const LISTING_TIMEOUT = Duration.seconds(30);

const SHA256_HEX = /^[0-9a-f]{64}$/;

/** Claude Code's platform names, for a Node `process.platform` and `process.arch`. */
const CLAUDE_CODE_PLATFORMS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  linux: { x64: "linux-x64", arm64: "linux-arm64" },
  darwin: { arm64: "darwin-arm64" },
  win32: { x64: "win32-x64" },
};

/**
 * Codex's targets. Its Linux builds are static (musl), which run on any
 * Linux; they are the ones its own installer picks.
 */
const CODEX_TARGETS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  linux: { x64: "x86_64-unknown-linux-musl", arm64: "aarch64-unknown-linux-musl" },
  darwin: { arm64: "aarch64-apple-darwin" },
  win32: { x64: "x86_64-pc-windows-msvc" },
};

const ClaudeManifest = Schema.Struct({
  version: HarnessVersion,
  platforms: Schema.Record(
    Schema.String,
    Schema.Struct({
      checksum: Schema.String,
      size: Schema.Int.check(Schema.isGreaterThan(0)),
    }),
  ),
});

const CodexListing = Schema.Struct({
  tag_name: Schema.String,
  assets: Schema.Array(
    Schema.Struct({ name: Schema.String, digest: Schema.NullOr(Schema.String) }),
  ),
});

/** A request to an origin no distribution is read from; nothing was sent. */
class OriginRefused extends Schema.TaggedError<OriginRefused>()("OriginRefused", {
  origin: Schema.String,
}) {}

/** The client a distribution is read through. */
export type DistributionClient = HttpClient.HttpClient.With<
  HttpClientError.HttpClientError | OriginRefused
>;

/**
 * `client`, sending requests only to `origins` and following no redirect:
 * `fetch` follows them on its own unless told not to, so it is told, and a
 * redirect is then an answer that is not a 200, which no read takes.
 */
export const onlyTo =
  (origins: ReadonlyArray<string>) =>
  (client: HttpClient.HttpClient): DistributionClient =>
    client.pipe(
      HttpClient.transform(
        (
          response,
          request,
        ): Effect.Effect<
          HttpClientResponse.HttpClientResponse,
          HttpClientError.HttpClientError | OriginRefused
        > => {
          const origin = URL.canParse(request.url) ? new URL(request.url).origin : request.url;
          return origins.includes(origin)
            ? response.pipe(
                Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
              )
            : Effect.fail(new OriginRefused({ origin }));
        },
      ),
    );

const unreachable = () => new HarnessFailed({ reason: "unreachable" });
const checksum = () => new HarnessFailed({ reason: "checksum" });

/**
 * A small file of the distribution, whole, as bytes, within
 * `LISTING_TIMEOUT` to its last byte. Only a 200 is an answer; a redirect is
 * not followed, so the file comes from `origin` or not at all, and one past
 * `MAX_LISTING_BYTES` is not a listing.
 */
const readSmall = Effect.fn("harnesses.readSmall")(
  function* (client: DistributionClient, url: string) {
    // The answer belongs to the read's scope, which ends it however the read
    // ends: unscoped, one left unread, by a refusal or an interruption, stayed
    // open until a garbage collection.
    const response = yield* HttpClient.withScope(client)
      .execute(HttpClientRequest.get(url))
      .pipe(Effect.mapError(unreachable));
    if (response.status !== 200) return yield* unreachable();
    const read = yield* response.stream.pipe(
      Stream.mapError(unreachable),
      Stream.runFoldEffect(
        () => ({ size: 0, chunks: new Array<Uint8Array>() }),
        (sofar, chunk) =>
          sofar.size + chunk.byteLength > MAX_LISTING_BYTES
            ? Effect.fail(unreachable())
            : Effect.succeed({
                size: sofar.size + chunk.byteLength,
                chunks: [...sofar.chunks, chunk],
              }),
      ),
    );
    const body = new Uint8Array(read.size);
    let offset = 0;
    for (const chunk of read.chunks) {
      body.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return body;
  },
  Effect.timeoutOrElse({ duration: LISTING_TIMEOUT, orElse: () => Effect.fail(unreachable()) }),
  Effect.scoped,
);

const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

const decodeJson = <S extends Schema.Top>(schema: S, bytes: Uint8Array) =>
  Schema.decodeEffect(Schema.fromJsonString(schema))(text(bytes)).pipe(
    Effect.mapError(unreachable),
  );

/** `sha256:<hex>`'s hex, lowercase; none for anything else. */
const digestHex = (digest: string | null): string | null => {
  const hex = digest?.startsWith("sha256:") === true ? digest.slice(7).toLowerCase() : null;
  return hex !== null && SHA256_HEX.test(hex) ? hex : null;
};

/** The SHA-256 a `SHA256SUMS` file gives `name`: a line `<hex>  <name>`, or `<hex> *<name>`. */
const sumFor = (sums: string, name: string): string | null => {
  for (const line of sums.split(/\r?\n/)) {
    const match = /^([0-9a-fA-F]{64}) [ *](.+)$/.exec(line.trim());
    if (match?.[2] === name && match[1] !== undefined) return match[1].toLowerCase();
  }
  return null;
};

/** Claude Code's distribution under `base`, for `platform` and `arch`. */
export const claudeCode = (
  client: DistributionClient,
  base: string,
  machine: { readonly platform: string; readonly arch: string },
): Distribution => {
  const platform = CLAUDE_CODE_PLATFORMS[machine.platform]?.[machine.arch];
  const fileName = machine.platform === "win32" ? "claude.exe" : "claude";
  return {
    origin: new URL(base).origin,
    installable: platform !== undefined,
    client,
    latest: Effect.gen(function* () {
      if (platform === undefined) return yield* unreachable();
      const version = yield* Schema.decodeEffect(HarnessVersion)(
        text(yield* readSmall(client, `${base}/stable`)).trim(),
      ).pipe(Effect.mapError(unreachable));
      const manifest = yield* decodeJson(
        ClaudeManifest,
        yield* readSmall(client, `${base}/${version}/manifest.json`),
      );
      // A manifest of another version than the channel named is not this release's.
      if (manifest.version !== version) return yield* unreachable();
      const build = manifest.platforms[platform];
      const sha256 = build?.checksum.toLowerCase();
      if (build === undefined || sha256 === undefined || !SHA256_HEX.test(sha256)) {
        return yield* checksum();
      }
      return {
        version,
        url: `${base}/${version}/${platform}/${fileName}`,
        sha256,
        size: build.size,
        format: "executable",
        fileName,
      } satisfies Release;
    }),
  };
};

/** Codex's distribution under `base`, for `platform` and `arch`. */
export const codex = (
  client: DistributionClient,
  base: string,
  machine: { readonly platform: string; readonly arch: string },
): Distribution => {
  const target = CODEX_TARGETS[machine.platform]?.[machine.arch];
  return {
    origin: new URL(base).origin,
    installable: target !== undefined,
    client,
    latest: Effect.gen(function* () {
      if (target === undefined) return yield* unreachable();
      const listing = yield* decodeJson(
        CodexListing,
        yield* readSmall(client, `${base}/channels/latest`),
      );
      // Codex tags its releases `rust-v<version>`.
      const version = yield* Schema.decodeEffect(HarnessVersion)(
        listing.tag_name.replace(/^rust-v/, ""),
      ).pipe(Effect.mapError(unreachable));
      const packageName = `codex-package-${target}.tar.gz`;
      const sumsName = "codex-package_SHA256SUMS";
      const listed = (name: string) =>
        digestHex(listing.assets.find((asset) => asset.name === name)?.digest ?? null);
      const packageDigest = listed(packageName);
      const sumsDigest = listed(sumsName);
      if (packageDigest === null || sumsDigest === null) return yield* checksum();
      const folder = `${base}/releases/${version}`;
      const sums = yield* readSmall(client, `${folder}/${sumsName}`);
      if (sha256Hex(sums) !== sumsDigest) return yield* checksum();
      if (sumFor(text(sums), packageName) !== packageDigest) return yield* checksum();
      return {
        version,
        url: `${folder}/${packageName}`,
        sha256: packageDigest,
        size: null,
        format: "tar.gz",
        fileName: packageName,
      } satisfies Release;
    }),
  };
};

/**
 * Each harness's distribution for this machine, read through `client`, which
 * may then reach only their origins.
 */
export const distributions = (
  client: HttpClient.HttpClient,
  machine: { readonly platform: string; readonly arch: string },
): Readonly<Record<SignInHarness, Distribution>> => {
  const guarded = onlyTo([new URL(CLAUDE_CODE_BASE).origin, new URL(CODEX_BASE).origin])(client);
  return {
    "claude-code": claudeCode(guarded, CLAUDE_CODE_BASE, machine),
    codex: codex(guarded, CODEX_BASE, machine),
  };
};
