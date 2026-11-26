// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  type Bot,
  type EngineStatus,
  type HarnessInstallFailure,
  type HarnessOutcome,
  type HarnessTask,
  type HarnessVersion,
  isNewerHarness,
  type ProviderStatus,
  type SignInHarness,
  signInHarnesses,
  type UnavailableReason,
} from "@j3-bots/contracts";
import type * as DateTime from "effect/DateTime";

/** A provider a bot can be created on: ready, with a model to pick. */
const canRunBots = (provider: ProviderStatus): boolean =>
  provider.status._tag === "ready" && provider.models.length > 0;

/**
 * Whether the server has a model for a bot created without one: a provider
 * that lists one and may still run it, as the server picks a default (one the
 * engine checked and cannot run is never it). False before the engine reports.
 */
export const hasDefaultModel = (engine: EngineStatus | null): boolean =>
  engine !== null &&
  engine.providers.some((provider) => provider.models.length > 0 && !cannotRun(provider));

/** Whether the engine is done checking `provider` and cannot run it. */
export const cannotRun = (provider: ProviderStatus): boolean =>
  provider.status._tag === "unavailable" && !provider.status.checking;

/** The one command that connects every provider that needs it; null when none does. */
export const connectCommand = (engine: EngineStatus): string | null =>
  engine.providers.flatMap((provider) =>
    provider.status._tag === "sign-in-required" ? [provider.status.command] : [],
  )[0] ?? null;

/**
 * What stands between the operator and a first bot, with the engine running:
 * - `ready`: a provider can run one;
 * - `checking`: none can yet, and the engine has not finished checking one
 *   since it started, so whether any needs connecting is not known yet;
 * - `connect`: one needs connecting, with the command that does it;
 * - `unavailable`: none can, and connecting would not change that.
 */
type ProviderGate =
  | { readonly _tag: "ready" }
  | { readonly _tag: "checking" }
  | { readonly _tag: "connect"; readonly command: string }
  | { readonly _tag: "unavailable" };

export const providerGate = (engine: EngineStatus): ProviderGate => {
  if (engine.providers.some(canRunBots)) return { _tag: "ready" };
  const checking = engine.providers.some(
    (provider) => provider.status._tag === "unavailable" && provider.status.checking,
  );
  if (checking) return { _tag: "checking" };
  const command = connectCommand(engine);
  return command === null ? { _tag: "unavailable" } : { _tag: "connect", command };
};

/**
 * What holds a bot's hello back, as the server holds it: the engine does not
 * report the bot's provider as ready.
 * - `connect`: a command connects a provider: the bot's own, signed out, or
 *   another when the bot's own cannot run at all (unavailable, and no longer
 *   being checked), which a bot on the server's default model moves to;
 * - `limit`: the bot's provider is at its usage limit, which resets at
 *   `resetsAt` when that is known;
 * - `provider`: anything else, such as a provider still being checked, or one
 *   the engine does not report.
 */
export type OpeningHold =
  | { readonly _tag: "connect"; readonly command: string }
  | { readonly _tag: "limit"; readonly resetsAt: DateTime.Utc | null }
  | { readonly _tag: "provider" };

/**
 * What holds the bot's hello back now (`OpeningHold`). Null while nothing
 * does: the hello is on its way or already said, or the engine's status is
 * not known yet.
 */
export const openingHeld = (bot: Bot, engine: EngineStatus | null): OpeningHold | null => {
  if (!bot.opening || engine === null) return null;
  const provider = engine.providers.find((p) => p.id === bot.model.providerId);
  if (provider === undefined) return { _tag: "provider" };
  switch (provider.status._tag) {
    case "ready":
      return null;
    case "sign-in-required":
      return { _tag: "connect", command: provider.status.command };
    case "limited":
      return { _tag: "limit", resetsAt: provider.status.resetsAt };
    case "unavailable": {
      if (provider.status.checking) return { _tag: "provider" };
      const command = connectCommand(engine);
      return command === null ? { _tag: "provider" } : { _tag: "connect", command };
    }
  }
};

/**
 * What the operator does about a provider the engine is done checking and
 * cannot run, from its line:
 * - `get`: its harness is not installed where the server runs, and the
 *   server installs its own copy of it (`provider.installHarness`).
 *   `failed` says why the last try did not, when it did not;
 * - `getting`: the server is installing it, as `task` says, and the
 *   operator may cancel;
 * - `install`: its harness is not installed, and the server cannot install
 *   it (an older server, or no build of it for the server's machine).
 *   `page` is where its maker says how, when J3 Bots knows it; once it is
 *   installed, the engine looks again (`engine.recheckProvider`);
 * - `retry`: it was found and failed; the engine checks it again.
 *   `rechecking` when its check timed out and the server already checks it
 *   again on its own (`retryAt`), so why it failed is known.
 * Null for any other state: one that runs or is being checked, a signed-out
 * provider (which the step's own sign-in or command connects), one turned
 * off on the server, which no client turns on, and one whose server gives no
 * reason, which also does not take `engine.recheckProvider`.
 */
export type ProviderFix =
  | {
      readonly _tag: "get";
      readonly harness: SignInHarness;
      readonly failed: HarnessInstallFailure | null;
    }
  | { readonly _tag: "getting"; readonly harness: SignInHarness; readonly task: HarnessTask }
  | { readonly _tag: "install"; readonly page: string | null }
  | { readonly _tag: "retry"; readonly rechecking: boolean };

export const providerFix = (provider: ProviderStatus): ProviderFix | null => {
  const { status } = provider;
  return status._tag === "unavailable" && !status.checking
    ? fixFor(status.reason, status.retryAt !== undefined, provider)
    : null;
};

const fixFor = (
  reason: UnavailableReason | undefined,
  rechecking: boolean,
  { harness, copy }: ProviderStatus,
): ProviderFix | null => {
  switch (reason) {
    case "not-installed":
      if (harness !== "other" && copy !== undefined && copy.source === "none") {
        if (copy.task !== null) return { _tag: "getting", harness, task: copy.task };
        if (copy.installable) {
          return {
            _tag: "get",
            harness,
            failed: copy.last?._tag === "failed" ? copy.last.reason : null,
          };
        }
      }
      return {
        _tag: "install",
        page: harness === "other" ? null : signInHarnesses[harness].installPage,
      };
    case "failed":
      return { _tag: "retry", rechecking };
    case "disabled":
    case "unknown":
    case undefined:
      return null;
  }
};

/**
 * The copy of its harness J3 Bots installed for a provider, as Settings
 * shows it: the version it runs, the newest its maker lists when that is
 * newer (`newer`, null otherwise), an update under way, and how the last
 * install or update ended. Null for a provider that runs the operator's own
 * harness or none, and on a server that installs none.
 */
export interface OwnHarness {
  readonly harness: SignInHarness;
  readonly version: HarnessVersion;
  readonly newer: HarnessVersion | null;
  readonly task: HarnessTask | null;
  readonly last: HarnessOutcome | null;
}

export const ownHarness = ({ harness, copy }: ProviderStatus): OwnHarness | null =>
  harness === "other" || copy === undefined || copy.source !== "j3" || copy.version === null
    ? null
    : {
        harness,
        version: copy.version,
        newer:
          copy.latest !== null && isNewerHarness(copy.latest, copy.version) ? copy.latest : null,
        task: copy.task,
        last: copy.last,
      };

/** Whether the server installs and updates its own copies of the harnesses: it says where each comes from. */
export const installsHarnesses = (engine: EngineStatus): boolean =>
  engine.providers.some((provider) => provider.copy !== undefined);
