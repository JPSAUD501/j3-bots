// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `x.y.z`, a release candidate of it, `x.y.z-rc.n`, or a nightly build before
 * it, `x.y.z-nightly.YYYYMMDD.run`, with no leading zeros.
 */
const VERSION =
  /^(?<major>0|[1-9][0-9]*)\.(?<minor>0|[1-9][0-9]*)\.(?<patch>0|[1-9][0-9]*)(?:-rc\.(?<rc>[1-9][0-9]*)|-nightly\.(?<day>[0-9]{8})\.[1-9][0-9]*)?$/;

/** The last release numbered with the first formula, which has no room for nightlies. */
const LAST_OF_THE_FIRST_FORMULA = [0, 3, 0] as const;

/** The stage of a release in the first formula, above each of its release candidates. */
const FIRST_FORMULA_RELEASE = 99;
/** Keeps the code under 2,100,000,000, the largest Google Play takes. */
const MAX_MAJOR = 20;
const MAX_MINOR_OR_PATCH = 99;
const MAX_RC = 98;
/** The stages of a version: its nightlies, then its release candidates, then the release. */
const RC = 9_000;
const RELEASE = 9_999;
/** A nightly's stage is the days from this date to its own, plus one. */
const FIRST_NIGHTLY_DAY = Date.UTC(2026, 0, 1);
const MAX_NIGHTLY = RC - 1;
const DAY = 86_400_000;

/** The days from 1 January 2026 to `day` (YYYYMMDD), or none when it is not a date. */
const daysToNightly = (day: string): number | undefined => {
  const [year, month, date] = [day.slice(0, 4), day.slice(4, 6), day.slice(6)].map(Number);
  if (year === undefined || month === undefined || date === undefined) return undefined;
  const time = Date.UTC(year, month - 1, date);
  const parsed = new Date(time);
  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== date
  )
    return undefined;
  return (time - FIRST_NIGHTLY_DAY) / DAY;
};

/**
 * The Android version code of an app version. Android installs an APK over the
 * app only when its version code is not lower than the installed one's, so the
 * code grows with the version.
 *
 * Up to `0.3.0`, the versions that shipped with it, the code is `major *
 * 1_000_000 + minor * 10_000 + patch * 100 + stage`, where the stage is `n`
 * for `-rc.n` and 99 for the release. That leaves no room for nightlies, so
 * from `0.3.1` it is `major * 100_000_000 + minor * 1_000_000 + patch * 10_000
 * + stage`, where the stage is 9,999 for the release, 9,000 + n for `-rc.n`,
 * and for a nightly the days from 2026-01-01 to its date, plus one. Every code
 * of the second formula is above every code of the first.
 *
 * A version this cannot order (another pre-release label, a nightly of `0.3.0`
 * or before, a date outside 2026-01-01 to 2050-08-21, a minor or patch above
 * 99, `-rc.99` and up, a major above 20) is refused, so the build fails rather
 * than ship a code that would block an update. The release workflow's `draft`
 * job refuses a version outside this grammar and these limits before anything
 * is built (.github/workflows/release.yml, "Check the version"): a change here
 * is made there too.
 */
export const androidVersionCode = (version: string): number => {
  const groups = VERSION.exec(version)?.groups;
  const major = groups?.["major"];
  const minor = groups?.["minor"];
  const patch = groups?.["patch"];
  if (major === undefined || minor === undefined || patch === undefined)
    throw new Error(
      `Version ${version} is not x.y.z, x.y.z-rc.n or x.y.z-nightly.YYYYMMDD.run, so it has no Android version code.`,
    );
  const [x, y, z] = [Number(major), Number(minor), Number(patch)];
  const rc = groups?.["rc"];
  const day = groups?.["day"];
  const [lastMajor, lastMinor, lastPatch] = LAST_OF_THE_FIRST_FORMULA;
  const firstFormula =
    x !== lastMajor ? x < lastMajor : y !== lastMinor ? y < lastMinor : z <= lastPatch;

  if (firstFormula) {
    if (day !== undefined)
      throw new Error(`Version ${version} has no Android version code: nightlies start at 0.3.1.`);
    if (rc !== undefined && Number(rc) > MAX_RC)
      throw new Error(
        `Version ${version} has no Android version code: a release candidate goes up to rc.${MAX_RC}.`,
      );
    return (
      x * 1_000_000 + y * 10_000 + z * 100 + (rc === undefined ? FIRST_FORMULA_RELEASE : Number(rc))
    );
  }

  const nightly = day === undefined ? undefined : daysToNightly(day);
  if (day !== undefined && (nightly === undefined || nightly < 0 || nightly + 1 > MAX_NIGHTLY))
    throw new Error(
      `Version ${version} has no Android version code: a nightly is dated from 2026-01-01 to 2050-08-21.`,
    );
  if (
    x > MAX_MAJOR ||
    y > MAX_MINOR_OR_PATCH ||
    z > MAX_MINOR_OR_PATCH ||
    (rc !== undefined && Number(rc) > MAX_RC)
  )
    throw new Error(
      `Version ${version} has no Android version code: the major version goes up to ${MAX_MAJOR}, the minor and the patch up to ${MAX_MINOR_OR_PATCH}, and a release candidate up to rc.${MAX_RC}.`,
    );
  const stage = nightly !== undefined ? nightly + 1 : rc !== undefined ? RC + Number(rc) : RELEASE;
  return x * 100_000_000 + y * 1_000_000 + z * 10_000 + stage;
};
