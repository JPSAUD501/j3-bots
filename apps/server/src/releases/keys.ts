// SPDX-License-Identifier: AGPL-3.0-or-later
import { RELEASE_KEYS, type ReleaseKey } from "@j3-bots/release";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

/**
 * The keys a release this server installs or offers must be signed with: the
 * project's (`RELEASE_KEYS`), and, for a mirror of the releases page, the
 * one `J3_RELEASE_PUBLIC_KEY` gives as PEM, as `scripts/install.sh` reads it.
 * That variable counts only beside `J3_RELEASE_BASE_URL`: it is for a test's
 * or a mirror's own releases, never a second key for GitHub's. Whoever can
 * set this server's environment can already run anything as its user, so it
 * opens nothing they could not.
 */
export const trustedReleaseKeys = Effect.gen(function* () {
  const mirror = yield* Config.option(Config.String("J3_RELEASE_BASE_URL"));
  const extra = yield* Config.option(Config.String("J3_RELEASE_PUBLIC_KEY"));
  if (Option.isNone(mirror) || Option.isNone(extra)) return RELEASE_KEYS;
  yield* Effect.logWarning("Release key from J3_RELEASE_PUBLIC_KEY trusted, for the mirror", {
    mirror: mirror.value,
  });
  return [
    ...RELEASE_KEYS,
    { id: "J3_RELEASE_PUBLIC_KEY", pem: extra.value },
  ] satisfies ReadonlyArray<ReleaseKey>;
});
