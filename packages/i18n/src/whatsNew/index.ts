// SPDX-License-Identifier: AGPL-3.0-or-later
import type { WhatsNewRelease } from "./types.ts";
import { v0_14_0 } from "./v0.14.0.ts";
import { v0_15_0 } from "./v0.15.0.ts";

// "What's new": what each release lets people do, in every language, shipped
// with the apps. One file per release, `v<x.y.z>.ts`, listed here. The release
// workflow refuses a tag whose version has none (docs/operations/releasing.md).

export type { InEveryLanguage, ReleaseNumber, WhatsNewEntry, WhatsNewRelease } from "./types.ts";

/** Every release's entries, from 0.14.0 on. */
export const WHATS_NEW: ReadonlyArray<WhatsNewRelease> = [v0_14_0, v0_15_0];

/** The entries of the release `version` (`x.y.z`), if it has any. */
export const whatsNewOf = (version: string): WhatsNewRelease | undefined =>
  WHATS_NEW.find((release) => release.version === version);
