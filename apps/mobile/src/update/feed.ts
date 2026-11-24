// SPDX-License-Identifier: AGPL-3.0-or-later
import { RELEASE_KEYS, type SignatureCheck } from "@j3-bots/release";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import Constants from "expo-constants";
import { signatureCheck } from "./signature.ts";

// Where the app takes its own update from, and the keys a release must be
// signed with, as the build says (app.config.ts, `extra.appUpdate`). A
// release build reads the project's releases on GitHub and trusts only the
// release key the app carries. A preview or development build updates itself
// only when it was built for a release server of its own with a key of its
// own, as the device checks of this flow are; otherwise it does not update
// itself at all, since no release is an update to it.

/** The project's releases on GitHub. */
const GITHUB = {
  api: "https://api.github.com/repos/JPSAUD501/j3-bots",
  site: "https://github.com/JPSAUD501/j3-bots",
} as const;

const AppUpdateConfig = Schema.Union([
  Schema.TaggedStruct("release", {}),
  Schema.TaggedStruct("test", { feed: Schema.String, key: Schema.String }),
]);

const Extra = Schema.Struct({ appUpdate: AppUpdateConfig });

/** Where releases are listed and downloaded, and the check their signature must pass. */
export interface ReleaseFeed {
  /** The project's releases, or a release server the build was made for. */
  readonly source: "release" | "test";
  /** The REST API's root for the repository: `<api>/releases`, `<api>/releases/latest`. */
  readonly api: string;
  /** The repository's page: `<site>/releases/download/v<version>/<file>`. */
  readonly site: string;
  readonly check: SignatureCheck;
}

/** This build's feed, or null when the build does not update itself. */
export const releaseFeed: ReleaseFeed | null = Option.match(
  Schema.decodeUnknownOption(Extra)(Constants.expoConfig?.extra),
  {
    onNone: () => null,
    onSome: ({ appUpdate }) =>
      appUpdate._tag === "release"
        ? {
            source: "release",
            ...GITHUB,
            check: signatureCheck(RELEASE_KEYS.map((key) => key.pem)),
          }
        : {
            source: "test",
            api: appUpdate.feed,
            site: appUpdate.feed,
            check: signatureCheck([appUpdate.key]),
          },
  },
);
