// SPDX-License-Identifier: AGPL-3.0-or-later
import type { VerificationFailure } from "@j3-bots/contracts";
import * as Base64 from "effect/encoding/Base64";
import * as Result from "effect/Result";

// Checking a release before anything of it is trusted. A release publishes
// `SHA256SUMS`, one `<sha256>  <name>` line per file, and `SHA256SUMS.sig`,
// the release key's Ed25519 signature over those exact bytes, base64. Order:
// the signature over `SHA256SUMS` first; then that the signed list is this
// release's; only then a file's digest from it, against the file's own.
// Nothing here reads a digest from a list whose signature did not verify:
// `VerifiedSums` is made only by `verifySums`.
//
// The signature check and the file hash are given, not done here, so this
// runs anywhere a client does: Node passes `node:crypto` (`./node.ts`), a
// phone its platform's.

/**
 * Whether `signature` is a release key's Ed25519 signature over `message`.
 * False for a signature of the wrong length too; never throws.
 */
export type SignatureCheck = (message: Uint8Array, signature: Uint8Array) => boolean;

/** The name of the file of digests, and of its signature, on every release. */
export const SUMS_FILE = "SHA256SUMS";
export const SIGNATURE_FILE = "SHA256SUMS.sig";

const ED25519_SIGNATURE_BYTES = 64;

/**
 * One line of `sha256sum`'s output: 64 lowercase hex digits, a space, ` ` or
 * `*` (binary mode), and a name with no folder, no control character and no
 * space at either end.
 */
const SUMS_LINE = /^([0-9a-f]{64}) [ *]([^\s/\\\p{Cc}](?:[^/\\\p{Cc}]*[^\s/\\\p{Cc}])?)$/u;

/** `SHA256SUMS.sig` as the release writes it: the 64 bytes in base64, 88 characters, and maybe one line feed. */
const SIGNATURE_TEXT = /^([A-Za-z0-9+/]{86}==)\n?$/;

/** Held only by this module: what `VerifiedSums`' constructor asks for. */
const VERIFIED = Symbol("VerifiedSums");

/** A release's `SHA256SUMS` whose signature verified and which names that release. */
export class VerifiedSums {
  readonly version: string;
  /** Each file's SHA-256, lowercase hex, by name. */
  readonly digests: ReadonlyMap<string, string>;
  constructor(token: typeof VERIFIED, version: string, digests: ReadonlyMap<string, string>) {
    if (token !== VERIFIED) throw new TypeError("Only verifySums makes a VerifiedSums.");
    this.version = version;
    this.digests = digests;
  }
}

/**
 * The files of `version` whose presence binds a `SHA256SUMS` to it: its
 * server archives, which every release has. A desktop package's name carries
 * no version, so without this a replayed older release, signed as genuinely
 * as this one, would pass for it.
 */
export const releaseAnchors = (version: string): ReadonlyArray<string> => [
  `j3-bots-${version}-linux-x64.tar.gz`,
  `j3-bots-${version}-linux-arm64.tar.gz`,
];

/**
 * Each line's digest by name: lines that end with a line feed, the last one
 * maybe without. A failure for a blank line, a line that is not one, a name
 * given twice, or no line at all.
 */
const parseSums = (
  text: string,
): Result.Result<ReadonlyMap<string, string>, VerificationFailure> => {
  const digests = new Map<string, string>();
  const lines = text.endsWith("\n") ? text.slice(0, -1).split("\n") : text.split("\n");
  for (const line of lines) {
    const parsed = SUMS_LINE.exec(line);
    const [digest, name] = [parsed?.[1], parsed?.[2]];
    if (digest === undefined || name === undefined || digests.has(name)) {
      return Result.fail("checksums-malformed");
    }
    digests.set(name, digest);
  }
  return digests.size === 0 ? Result.fail("checksums-malformed") : Result.succeed(digests);
};

/** The 64 bytes `SHA256SUMS.sig` holds; `signature-invalid` when it holds anything else. */
const signatureBytes = (file: Uint8Array): Result.Result<Uint8Array, VerificationFailure> => {
  const encoded = SIGNATURE_TEXT.exec(new TextDecoder("utf-8", { fatal: false }).decode(file))?.[1];
  if (encoded === undefined) return Result.fail("signature-invalid");
  return Result.flatMap(
    Result.mapError(Base64.decode(encoded), (): VerificationFailure => "signature-invalid"),
    (bytes) =>
      bytes.length === ED25519_SIGNATURE_BYTES
        ? Result.succeed(bytes)
        : Result.fail<VerificationFailure>("signature-invalid"),
  );
};

/**
 * `sums`, the bytes of `version`'s `SHA256SUMS`, once `signature`, the bytes
 * of its `SHA256SUMS.sig` (null when the release has none), verifies with
 * `check` and the list names `version`'s server archives.
 */
export const verifySums = (input: {
  readonly version: string;
  readonly sums: Uint8Array;
  readonly signature: Uint8Array | null;
  readonly check: SignatureCheck;
}): Result.Result<VerifiedSums, VerificationFailure> => {
  if (input.signature === null) return Result.fail("signature-missing");
  return Result.flatMap(signatureBytes(input.signature), (signature) => {
    if (!input.check(input.sums, signature)) return Result.fail("signature-invalid");
    const text = new TextDecoder("utf-8", { fatal: true });
    let decoded: string;
    try {
      decoded = text.decode(input.sums);
    } catch {
      return Result.fail("checksums-malformed");
    }
    return Result.flatMap(parseSums(decoded), (digests) =>
      releaseAnchors(input.version).some((anchor) => digests.has(anchor))
        ? Result.succeed(new VerifiedSums(VERIFIED, input.version, digests))
        : Result.fail<VerificationFailure>("wrong-release"),
    );
  });
};

/** The SHA-256 the verified list gives `file`, lowercase hex. */
export const expectedDigest = (
  sums: VerifiedSums,
  file: string,
): Result.Result<string, "entry-missing"> => {
  const digest = sums.digests.get(file);
  return digest === undefined ? Result.fail("entry-missing") : Result.succeed(digest);
};

/** Whether `actual`, the SHA-256 of the downloaded `file` in hex, is the one the verified list gives it. */
export const checkDigest = (
  sums: VerifiedSums,
  file: string,
  actual: string,
): Result.Result<void, "entry-missing" | "digest-mismatch"> =>
  Result.flatMap(expectedDigest(sums, file), (expected) =>
    expected === actual.toLowerCase() ? Result.void : Result.fail("digest-mismatch"),
  );
