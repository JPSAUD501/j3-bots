// SPDX-License-Identifier: AGPL-3.0-or-later

// Whether the server's environment lets it send usage data at all, and where
// to. The operator's switch in Settings decides the rest (`TelemetrySwitch`).
// The rules follow T3 Code's at `bc0f04d` (`AnalyticsService.ts` and
// `packages/shared/src/otelEnvironment.ts`, MIT), with J3 Bots' own names.

/** J3 Bots' PostHog project, US cloud. */
export const DEFAULT_TELEMETRY_HOST = "https://us.i.posthog.com";

/**
 * The project's API key. It can only write events into the project, never
 * read them, so it is public by design, as every PostHog client key is; a
 * fork sends elsewhere with `J3_TELEMETRY_KEY` and `J3_TELEMETRY_HOST`.
 */
export const DEFAULT_TELEMETRY_KEY = "phc_odHxfk78pDje6tTFzZ9sJ5dTUzPLDt3x9JMTb2UaYLmP";

/**
 * Why the environment keeps usage data off, whatever the switch says:
 * - `do-not-track`: `DO_NOT_TRACK` is set, which wins over everything;
 * - `turned-off`: `J3_TELEMETRY_ENABLED` is false, or not a yes or a no;
 * - `invalid-destination`: `J3_TELEMETRY_HOST` is not an http or https
 *   address, or `J3_TELEMETRY_KEY` is empty;
 * - `ci`: a CI runner, which is not an install;
 * - `development`: a run from a source checkout, which is not one either.
 *
 * `J3_TELEMETRY_ENABLED=true` lifts the last two, never the others.
 */
export type TelemetryHold =
  | "do-not-track"
  | "turned-off"
  | "invalid-destination"
  | "ci"
  | "development";

export interface TelemetryEnvironment {
  /** Null when the environment allows sending; the switch decides then. */
  readonly hold: TelemetryHold | null;
  /** Where batches go: `<host>/batch/`. */
  readonly host: string;
  readonly key: string;
}

/** Yes and no as T3 Code reads them, which are Effect's `Config.Boolean`'s. */
const YES: ReadonlySet<string> = new Set(["true", "yes", "on", "1", "y"]);
const NO: ReadonlySet<string> = new Set(["false", "no", "off", "0", "n"]);

/** Variables CI services set on their runners (T3 Code's list). `CI=false` or `CI=0` is no CI. */
const CI_VARIABLES = [
  "CI",
  "GITHUB_ACTIONS",
  "GITLAB_CI",
  "CIRCLECI",
  "TRAVIS",
  "BUILDKITE",
  "JENKINS_URL",
  "TEAMCITY_VERSION",
  "TF_BUILD",
  "BITBUCKET_BUILD_NUMBER",
  "CODEBUILD_BUILD_ID",
  "DRONE",
  "APPVEYOR",
] as const;

type Environment = Readonly<Record<string, string | undefined>>;

const read = (environment: Environment, name: string): string | undefined => {
  const value = environment[name]?.trim().toLowerCase();
  return value === undefined || value === "" ? undefined : value;
};

const isCi = (environment: Environment) =>
  CI_VARIABLES.some((name) => {
    const value = read(environment, name);
    return value !== undefined && value !== "false" && value !== "0";
  });

const isHttpOrigin = (value: string) => {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
};

/**
 * What `environment` allows, for a server that runs from a source checkout
 * when `development` is true. An opt-out that cannot be read is an opt-out:
 * someone who wrote `J3_TELEMETRY_ENABLED=flase` meant to turn it off.
 */
export const telemetryEnvironment = (
  environment: Environment,
  development: boolean,
): TelemetryEnvironment => {
  const host = (environment["J3_TELEMETRY_HOST"]?.trim() || DEFAULT_TELEMETRY_HOST).replace(
    /\/+$/,
    "",
  );
  const key = environment["J3_TELEMETRY_KEY"]?.trim() ?? DEFAULT_TELEMETRY_KEY;
  const destination = { host, key };
  const doNotTrack = read(environment, "DO_NOT_TRACK");
  if (doNotTrack !== undefined && YES.has(doNotTrack)) {
    return { hold: "do-not-track", ...destination };
  }
  const enabled = read(environment, "J3_TELEMETRY_ENABLED");
  if (enabled !== undefined && !YES.has(enabled)) {
    return { hold: "turned-off", ...destination };
  }
  if (!isHttpOrigin(host) || key === "") return { hold: "invalid-destination", ...destination };
  if (enabled !== undefined) return { hold: null, ...destination };
  if (isCi(environment)) return { hold: "ci", ...destination };
  if (development) return { hold: "development", ...destination };
  return { hold: null, ...destination };
};

/** Whether `hold` comes from a value the operator wrote that the server cannot read. */
export const unreadableOptOut = (environment: Environment): boolean => {
  const enabled = read(environment, "J3_TELEMETRY_ENABLED");
  return enabled !== undefined && !YES.has(enabled) && !NO.has(enabled);
};
