// SPDX-License-Identifier: AGPL-3.0-or-later
import * as Schema from "effect/Schema";
import pinFile from "../../../../engine.json" with { type: "json" };

// The one T3 Code release J3 Bots is built and tested against. `engine.json`
// at the repository root is the source of truth; `pnpm vendor:t3-contracts`
// reads the same file, so the schemas and the binary always match.

const EnginePin = Schema.Struct({
  version: Schema.String.check(Schema.isPattern(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$/)),
  commit: Schema.String.check(Schema.isPattern(/^[0-9a-f]{40}$/)),
});

export const pin = Schema.decodeSync(EnginePin)(pinFile);

/** The orchestration protocol the adapter speaks. The engine refuses any other. */
export const ORCHESTRATION_PROTOCOL = 2;

const RELEASES = "https://github.com/pingdotgg/t3code/releases/download";

export const releaseUrl = (file: string) => `${RELEASES}/v${pin.version}/${file}`;

/** The standalone server archive for a release platform such as `linux-x64`. */
export const archiveName = (releasePlatform: string) =>
  `t3-${pin.version}-${releasePlatform}.tar.gz`;
