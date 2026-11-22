// SPDX-License-Identifier: AGPL-3.0-or-later

/** `x.y.z`, or a release candidate of it, `x.y.z-rc.n`, with no leading zeros. */
const VERSION =
  /^(?<major>0|[1-9][0-9]*)\.(?<minor>0|[1-9][0-9]*)\.(?<patch>0|[1-9][0-9]*)(?:-rc\.(?<rc>[1-9][0-9]*))?$/;

/** Keeps the code under 2,100,000,000, the largest Google Play takes. */
const MAX_MAJOR = 2099;
const MAX_MINOR_OR_PATCH = 99;
const MAX_RC = 98;
/** The stage of a release, above each of its release candidates. */
const RELEASE = 99;

/**
 * The Android version code of an app version. Android installs an APK over the
 * app only when its version code is not lower than the installed one's, so the
 * code grows with the version: `major * 1_000_000 + minor * 10_000 + patch *
 * 100 + stage`, where the stage is `n` for `-rc.n` and 99 for the release, which
 * puts each release candidate below its release. A version this cannot order
 * (another pre-release label, a minor or patch above 99, `-rc.99` and up, a
 * major above 2099) is refused, so the build fails rather than ship a code that
 * would block an update. The release workflow's `draft` job refuses a tag
 * outside this grammar and these limits before anything is built
 * (.github/workflows/release.yml, "Version from the tag"): a change here is
 * made there too.
 */
export const androidVersionCode = (version: string): number => {
  const groups = VERSION.exec(version)?.groups;
  const major = groups?.["major"];
  const minor = groups?.["minor"];
  const patch = groups?.["patch"];
  if (major === undefined || minor === undefined || patch === undefined)
    throw new Error(
      `Version ${version} is not x.y.z or x.y.z-rc.n, so it has no Android version code.`,
    );
  const rc = groups?.["rc"];
  const stage = rc === undefined ? RELEASE : Number(rc);
  if (
    Number(major) > MAX_MAJOR ||
    Number(minor) > MAX_MINOR_OR_PATCH ||
    Number(patch) > MAX_MINOR_OR_PATCH ||
    (rc !== undefined && stage > MAX_RC)
  )
    throw new Error(
      `Version ${version} has no Android version code: the major version goes up to ${MAX_MAJOR}, the minor and the patch up to ${MAX_MINOR_OR_PATCH}, and a release candidate up to rc.${MAX_RC}.`,
    );
  return Number(major) * 1_000_000 + Number(minor) * 10_000 + Number(patch) * 100 + stage;
};
