// SPDX-License-Identifier: AGPL-3.0-or-later
import type { UpdateChannel } from "@j3-bots/contracts";
import * as Option from "effect/Option";
import type { Ordering } from "effect/Ordering";

// How J3 Bots numbers its releases, and the order an update follows. A stable
// release is `X.Y.Z`; a release candidate `X.Y.Z-rc.N`; a nightly build
// `X.Y.Z-nightly.YYYYMMDD.N`, where X.Y.Z is the patch after the stable release
// it was built after, the date is the build's, in UTC, and N the build's run.
// Semantic versioning orders them, so a nightly sorts after the stable release
// before it and before the next one, and two nightlies by date, then by run.

/** A version as releases are numbered: `0.3.0`, `0.3.0-rc.1`, semantic versioning's order. */
const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

/** A stable release: no pre-release part and no build. */
const STABLE = /^\d+\.\d+\.\d+$/;

/** A nightly build: `X.Y.Z-nightly.YYYYMMDD.N`, numbers without leading zeros. */
const NIGHTLY = /^\d+\.\d+\.\d+-nightly\.[1-9]\d{7}\.(?:0|[1-9]\d*)$/;

/** -1, 0 or 1 as `a` sorts before, with or after `b`. */
const sign = <T extends number | string>(a: T, b: T): Ordering => (a < b ? -1 : a > b ? 1 : 0);

/** A pre-release's identifiers in order: numbers sort below names, and fewer below more. */
const comparePrerelease = (a: ReadonlyArray<string>, b: ReadonlyArray<string>): Ordering => {
  for (let index = 0; index < Math.min(a.length, b.length); index++) {
    const [x, y] = [a[index] ?? "", b[index] ?? ""];
    const [xNumber, yNumber] = [/^\d+$/.test(x), /^\d+$/.test(y)];
    const order: Ordering =
      xNumber && yNumber
        ? sign(Number(x), Number(y))
        : xNumber !== yNumber
          ? xNumber
            ? -1
            : 1
          : sign(x, y);
    if (order !== 0) return order;
  }
  return sign(a.length, b.length);
};

/** How `a` orders against `b`, -1, 0 or 1; none when either is not a version releases are numbered with. */
export const compareVersions = (a: string, b: string): Option.Option<Ordering> => {
  const [x, y] = [SEMVER.exec(a), SEMVER.exec(b)];
  if (x === null || y === null) return Option.none();
  for (const part of [1, 2, 3]) {
    const order = sign(Number(x[part]), Number(y[part]));
    if (order !== 0) return Option.some(order);
  }
  const [xPre, yPre] = [x[4], y[4]];
  if (xPre === undefined || yPre === undefined) {
    // A release sorts after its pre-releases.
    return Option.some(xPre === yPre ? 0 : xPre === undefined ? 1 : -1);
  }
  return Option.some(comparePrerelease(xPre.split("."), yPre.split(".")));
};

/**
 * Whether `candidate` sorts strictly after `running`. False when it does
 * not, and when either cannot be ordered: an update only ever goes forward,
 * so what cannot be shown to be newer is not.
 */
export const isNewer = (candidate: string, running: string): boolean =>
  Option.getOrElse(
    Option.map(compareVersions(candidate, running), (order) => order > 0),
    () => false,
  );

/**
 * The channel a version is published on: `stable` for `X.Y.Z`, `nightly` for
 * a nightly build; none for anything else, a release candidate included,
 * which no channel offers.
 */
export const channelOf = (version: string): Option.Option<UpdateChannel> =>
  STABLE.test(version)
    ? Option.some("stable")
    : NIGHTLY.test(version)
      ? Option.some("nightly")
      : Option.none();

/**
 * The tag a release of `version` is published under, which names its folder
 * on the releases page: the bare version for a nightly build, and `v<version>`
 * for any other release. Nightly tags stay outside the protected `v*` tags,
 * which only a maintainer may push.
 */
export const releaseTag = (version: string): string =>
  NIGHTLY.test(version) ? version : `v${version}`;

/**
 * Whether a release of `channel` may be offered on `subscribed`: a stable
 * release on either, since a stable release is a build of `main` too; a
 * nightly only to those who chose nightly.
 */
export const offeredOn = (channel: UpdateChannel, subscribed: UpdateChannel): boolean =>
  channel === "stable" || subscribed === "nightly";
