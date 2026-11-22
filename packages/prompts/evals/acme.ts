// SPDX-License-Identifier: AGPL-3.0-or-later
import type * as DateTime from "effect/DateTime";
import type { GitHub, PullRequest, Run } from "./fixtures.ts";

/**
 * acme/docs, the fictional repository the evals' bot looks after, as the
 * stand-in `gh` serves it: its CI runs on `main`, passing or with a failure,
 * and its pull requests.
 */

export const PASSING_RUNS: ReadonlyArray<Run> = [
  {
    id: 1042,
    title: "Fix typo in setup guide",
    conclusion: "success",
    elapsed: "3m12s",
    minutesAgo: 62,
    jobs: [
      { id: 5420, name: "build", conclusion: "success", duration: "2m05s" },
      { id: 5421, name: "link-check", conclusion: "success", duration: "58s" },
    ],
  },
  {
    id: 1041,
    title: "Bump theme to 4.2",
    conclusion: "success",
    elapsed: "3m40s",
    minutesAgo: 1_510,
    jobs: [
      { id: 5410, name: "build", conclusion: "success", duration: "2m21s" },
      { id: 5411, name: "link-check", conclusion: "success", duration: "1m04s" },
    ],
  },
];

export const FAILING_RUNS: ReadonlyArray<Run> = [
  {
    id: 1043,
    title: "Add pricing page",
    conclusion: "failure",
    elapsed: "2m40s",
    minutesAgo: 31,
    jobs: [
      { id: 5430, name: "build", conclusion: "success", duration: "1m31s" },
      {
        id: 5431,
        name: "link-check",
        conclusion: "failure",
        duration: "1m02s",
        failure: {
          step: "Check links",
          path: "guides/pricing.md",
          error: "link to /plans returns 404",
        },
      },
    ],
  },
  ...PASSING_RUNS,
];

const OPEN_PULL_REQUESTS: ReadonlyArray<PullRequest> = [
  {
    number: 125,
    title: "Fix broken anchors in FAQ",
    author: "lena",
    branch: "faq-anchors",
    state: "open",
    minutesAgo: 20,
  },
  {
    number: 124,
    title: "Document the new search API",
    author: "omar",
    branch: "search-api",
    state: "open",
    minutesAgo: 40,
  },
  {
    number: 121,
    title: "Add French translation of quickstart",
    author: "claire",
    branch: "quickstart-fr",
    state: "open",
    minutesAgo: 75,
  },
  {
    number: 118,
    title: "Update install guide for Node 22",
    author: "dana",
    branch: "node-22",
    state: "open",
    minutesAgo: 1_500,
  },
];

/** Pull request #12, still open. */
export const TWELVE_OPEN: PullRequest = {
  number: 12,
  title: "Move the API reference to the new layout",
  author: "mira",
  branch: "api-layout",
  state: "open",
  minutesAgo: 9_000,
};

/** #12, merged `minutesAgo` minutes ago. */
export const twelveMerged = (minutesAgo: number): PullRequest => ({
  ...TWELVE_OPEN,
  state: "merged",
  mergedMinutesAgo: minutesAgo,
});

/** acme/docs at `now`, with #12 merged unless `twelve` says otherwise, and `gh` signed in unless `signedIn` is false. */
export const github = (
  now: DateTime.Utc,
  runs: ReadonlyArray<Run>,
  {
    signedIn = true,
    twelve = twelveMerged(25),
    token,
  }: { signedIn?: boolean; twelve?: PullRequest; token?: string } = {},
): GitHub => ({
  now,
  runs,
  pullRequests: [...OPEN_PULL_REQUESTS, twelve],
  signedIn,
  ...(token === undefined ? {} : { token }),
});
