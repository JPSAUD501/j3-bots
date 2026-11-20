// SPDX-License-Identifier: AGPL-3.0-or-later
// @effect-diagnostics nodeBuiltinImport:off -- Whether a certificate and key form a pair, and the names a certificate covers, come only from node:tls and node:crypto.
import * as NodeCrypto from "node:crypto";
import * as NodeTls from "node:tls";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";

/** A certificate and key, as the HTTPS listener takes them. */
export interface TlsCredentials {
  readonly cert: string;
  readonly key: string;
  /** The DNS names the certificate is issued for, which clients open it at. */
  readonly names: ReadonlyArray<string>;
}

/** The configured certificate and key cannot serve HTTPS. */
class TlsUnusable extends Schema.TaggedError<TlsUnusable>()("TlsUnusable", {
  reason: Schema.Literals(["unreadable", "not-a-pair"]),
  /** The file that cannot be read, or the certificate of the pair. */
  path: Schema.String,
}) {
  override get message(): string {
    switch (this.reason) {
      case "unreadable":
        return `${this.path} cannot be read by this user.`;
      case "not-a-pair":
        return `The certificate ${this.path} and its key do not form a usable pair: one is not PEM, or the key is not the certificate's.`;
    }
  }
}

/** `DNS:a.example, IP Address:10.0.0.1` → the DNS names. */
const dnsNames = (subjectAltName: string | undefined) =>
  (subjectAltName ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .flatMap((entry) => (entry.startsWith("DNS:") ? [entry.slice("DNS:".length)] : []));

/**
 * Reads a certificate and key and checks that Node can serve with them, the
 * way the HTTPS listener will, without opening one.
 */
export const load = Effect.fn("Tls.load")(function* (paths: {
  readonly certPath: string;
  readonly keyPath: string;
}) {
  const fs = yield* FileSystem.FileSystem;
  const read = (path: string) =>
    fs
      .readFileString(path)
      .pipe(Effect.mapError(() => new TlsUnusable({ reason: "unreadable", path })));
  const cert = yield* read(paths.certPath);
  const key = yield* read(paths.keyPath);
  return yield* Effect.try({
    try: (): TlsCredentials => {
      NodeTls.createSecureContext({ cert, key });
      return { cert, key, names: dnsNames(new NodeCrypto.X509Certificate(cert).subjectAltName) };
    },
    catch: () => new TlsUnusable({ reason: "not-a-pair", path: paths.certPath }),
  });
});
