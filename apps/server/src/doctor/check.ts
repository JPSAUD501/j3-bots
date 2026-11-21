// SPDX-License-Identifier: AGPL-3.0-or-later
import * as Option from "effect/Option";

export type CheckStatus = "ok" | "warning" | "problem" | "skipped";

/** One line of `j3-bots doctor`: what it found and, when something is wrong, the fix. */
export interface Check {
  readonly name: string;
  readonly status: CheckStatus;
  readonly summary: string;
  readonly fix: Option.Option<string>;
}

export const check = (name: string, status: CheckStatus, summary: string, fix?: string): Check => ({
  name,
  status,
  summary,
  fix: Option.fromNullishOr(fix),
});
