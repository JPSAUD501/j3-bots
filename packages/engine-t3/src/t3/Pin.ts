// SPDX-License-Identifier: AGPL-3.0-or-later
import * as Schema from "effect/Schema";
import pinFile from "../../../../engine.json" with { type: "json" };

// The one T3 Code release J3 Bots is built and tested against. `engine.json`
// at the repository root is the source of truth; `pnpm vendor:t3-contracts`
// reads the same file, so the schemas and the binary always match.
//
// `sha256` is the digest of each platform's standalone server archive, keyed
// by the release's platform name (`linux-x64`). The vendoring script copies it
// from the release's `SHA256SUMS` when the pin moves, so a moved pin shows the
// digests in its diff, and an install accepts only the archive the pin was
// tested with: not a release rebuilt under the same version afterwards.

const Sha256 = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/));

const EnginePin = Schema.Struct({
  version: Schema.String.check(Schema.isPattern(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$/)),
  commit: Schema.String.check(Schema.isPattern(/^[0-9a-f]{40}$/)),
  sha256: Schema.Record(Schema.String, Sha256),
});

export const pin = Schema.decodeSync(EnginePin)(pinFile);

/** The orchestration protocol the adapter speaks. The engine refuses any other. */
export const ORCHESTRATION_PROTOCOL = 2;

const RELEASES = "https://github.com/pingdotgg/t3code/releases/download";

export const releaseUrl = (file: string) => `${RELEASES}/v${pin.version}/${file}`;

/** The standalone server archive for a release platform such as `linux-x64`. */
export const archiveName = (releasePlatform: string) =>
  `t3-${pin.version}-${releasePlatform}.tar.gz`;
