// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Language } from "@j3-bots/contracts";

/** A text written in every language J3 Bots has: a language missing does not type-check. */
export type InEveryLanguage = { readonly [L in Language]: string };

/** One thing a release lets people do, written for someone who isn't technical. */
export interface WhatsNewEntry {
  /** What you can now do, in a few words. */
  readonly title: InEveryLanguage;
  /** One or two plain sentences on it. */
  readonly body: InEveryLanguage;
  /** Where to find it, when the body doesn't already say. */
  readonly where?: InEveryLanguage;
}

/** A stable release's number, as its tag names it without the `v`: `0.14.0`. */
export type ReleaseNumber = `${number}.${number}.${number}`;

/** What one release brought, in the order it is read. */
export interface WhatsNewRelease {
  readonly version: ReleaseNumber;
  readonly entries: readonly [WhatsNewEntry, ...WhatsNewEntry[]];
}
