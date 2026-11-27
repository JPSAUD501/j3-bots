// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  type EngineStatus,
  type HarnessCopy,
  type HarnessInstallFailure,
  type HarnessLocation,
  type HarnessTask,
  type ProviderId,
  type ProviderStatus,
  type SignInFailure,
  type SignInHarness,
  signInHarnesses,
} from "@j3-bots/contracts";
import type * as DateTime from "effect/DateTime";
import type { SignInView } from "../stores/ProviderSetup.ts";
import { providerFix } from "./engine.ts";

// Connecting an AI, as the operator meets it: the account they already have,
// Claude or ChatGPT, never the harness that signs it in
// (docs/decisions/0066-connecting-an-ai-is-picking-the-account-you-have.md).

/** An AI account a bot can think with. Each signs in through one harness, which the operator never has to name. */
export type AiAccount = SignInHarness;

/** The accounts, in the order every screen offers them. */
export const aiAccounts: ReadonlyArray<AiAccount> = ["claude-code", "codex"];

/**
 * What the operator calls each account, and who makes it. Product names, so
 * no language changes them. `product` is the harness behind it, which shows
 * only as a choice's subtitle and in the details.
 */
export const aiAccountNames: Readonly<
  Record<AiAccount, { readonly name: string; readonly maker: string; readonly product: string }>
> = {
  "claude-code": { name: "Claude", maker: "Anthropic", product: "Claude Code" },
  codex: { name: "ChatGPT", maker: "OpenAI", product: "Codex" },
};

/**
 * What the operator calls the AI a bot thinks with: its account's name, such
 * as Claude, or the engine's name for any other provider. Null while the
 * engine does not list the provider.
 */
export const aiNameOf = (engine: EngineStatus | null, providerId: ProviderId): string | null => {
  const provider = engine?.providers.find((one) => one.id === providerId);
  if (provider === undefined) return null;
  return provider.harness === "other" ? provider.name : aiAccountNames[provider.harness].name;
};

/**
 * Where an account of the server this client talks to signs in:
 * - `here`: in this app, when the server runs on this computer;
 * - `desktop-app`: in the desktop app that runs the server, seen from another device;
 * - `server`: on the machine J3 Bots is installed on, with a command.
 */
export type AiPlace = "here" | "desktop-app" | "server";

/**
 * Where one account stands, as one screen shows it:
 * - `ready`: connected, and a bot can think with it. `limit` while it is at
 *   its plan's usage limit, which is connected all the same: when the limit
 *   resets, null when the provider does not say;
 * - `finishing`: signed in, and J3 Bots is checking it before bots use it;
 * - `signing-in`: a sign-in runs. `step` is how far it is: `opening` until
 *   its page is known, then `browser`, with the `page` to open again;
 * - `getting`: J3 Bots is downloading what the account needs, at `task`.
 *   `progress` from 0 to 1, null when the download does not say its size or
 *   is past downloading;
 * - `sign-in`: everything is there, and the account is signed out. `failed`
 *   is why the last sign-in from this client ended without signing in;
 * - `missing`: what the account needs is not on the server. `canGet` when
 *   the server downloads it itself, and `failed` why its last try did not;
 *   otherwise `page` is where its maker says how to install it;
 * - `checking`: the server has not finished checking it yet;
 * - `problem`: it is there and cannot run: `failed` to start, `timed-out`
 *   when its check took too long and the server checks again on its own,
 *   `off` when it is turned off on the server, `unknown` for a reason a
 *   newer server gives;
 * - `preparing`: nothing is known of it yet: the server has not answered, or
 *   J3 Bots is still starting on a server that does not say what it installs.
 *   How far J3 Bots itself is, the screen says once, not on each account.
 */
export type AiAccountState =
  | { readonly _tag: "ready"; readonly limit: { readonly resetsAt: DateTime.Utc | null } | null }
  | { readonly _tag: "finishing" }
  | {
      readonly _tag: "signing-in";
      readonly step: "opening" | "browser";
      readonly page: string | null;
    }
  | {
      readonly _tag: "getting";
      readonly task: HarnessTask["_tag"];
      readonly progress: number | null;
    }
  | { readonly _tag: "sign-in"; readonly failed: SignInFailure | "unknown" | null }
  | {
      readonly _tag: "missing";
      readonly canGet: boolean;
      readonly failed: HarnessInstallFailure | null;
      readonly page: string | null;
    }
  | { readonly _tag: "checking" }
  | { readonly _tag: "problem"; readonly kind: "failed" | "timed-out" | "off" | "unknown" }
  | { readonly _tag: "preparing" };

/** What a screen knows about the accounts, from the server and from this client's own sign-ins. */
export interface AiFacts {
  /**
   * The accounts whose last sign-in already led to a connection: its success
   * says nothing of an account found signed out again later, which is then
   * offered a sign-in instead of being said to be finishing.
   */
  readonly spent?: ReadonlySet<AiAccount>;
  /** The engine's status; null until the server has reported it. */
  readonly engine: EngineStatus | null;
  /**
   * Where the server finds what each account needs; null when it has not
   * said, as on a client that does not sign in from here.
   */
  readonly locations: ReadonlyArray<HarnessLocation> | null;
  /** Each sign-in this client follows; an account not in it has none. */
  readonly signIns: ReadonlyMap<AiAccount, SignInView>;
}

/**
 * The provider that runs on `account`: the one a bot can use now when there
 * is one, else the first the engine lists for it.
 */
export const aiAccountProvider = (
  engine: EngineStatus | null,
  account: AiAccount,
): ProviderStatus | undefined => {
  const mine = (engine?.providers ?? []).filter((provider) => provider.harness === account);
  return mine.find((provider) => provider.status._tag === "ready") ?? mine[0];
};

/** A part of a whole, from 0 to 1; null when the whole is not known. */
const part = (received: number, total: number | null): number | null =>
  total === null || total <= 0 ? null : Math.min(1, received / total);

const fromProvider = (provider: ProviderStatus): AiAccountState => {
  const { status } = provider;
  switch (status._tag) {
    case "ready":
      return provider.models.length > 0 ? { _tag: "ready", limit: null } : { _tag: "finishing" };
    case "limited":
      return { _tag: "ready", limit: { resetsAt: status.resetsAt } };
    case "sign-in-required":
      return { _tag: "sign-in", failed: null };
    case "unavailable": {
      // J3 Bots' own install of what the account needs comes first, also
      // while the engine still checks the provider (`providerFix`).
      const fix = providerFix(provider);
      switch (fix?._tag) {
        case "getting":
          return getting(fix.task);
        case "get":
          return { _tag: "missing", canGet: true, failed: fix.failed, page: null };
        case "install":
          return { _tag: "missing", canGet: false, failed: null, page: fix.page };
        case "retry":
          return { _tag: "problem", kind: fix.rechecking ? "timed-out" : "failed" };
        case undefined:
          if (status.checking) return { _tag: "checking" };
          return { _tag: "problem", kind: status.reason === "disabled" ? "off" : "unknown" };
      }
    }
  }
};

/** An install of what the account needs, under way at `task`. */
const getting = (task: HarnessTask): AiAccountState => ({
  _tag: "getting",
  task: task._tag,
  progress: task._tag === "downloading" ? part(task.receivedBytes, task.totalBytes) : null,
});

/**
 * Where an account stands before the engine reports its provider, as while
 * J3 Bots starts, from the server's copy of what it needs
 * (`EngineStatus.harnesses`), which the server starts downloading as it
 * starts: there already, so the account can sign in; downloading; failed,
 * and why; not one the server installs here; or not started, as after the
 * operator stopped it.
 */
const fromCopy = (account: AiAccount, copy: HarnessCopy): AiAccountState => {
  if (copy.source !== "none") return { _tag: "sign-in", failed: null };
  if (copy.task !== null) return getting(copy.task);
  if (!copy.installable) {
    return {
      _tag: "missing",
      canGet: false,
      failed: null,
      page: signInHarnesses[account].installPage,
    };
  }
  return {
    _tag: "missing",
    canGet: true,
    failed: copy.last?._tag === "failed" ? copy.last.reason : null,
    page: null,
  };
};

/**
 * Where `account` stands (`AiAccountState`). A sign-in under way comes
 * first, since it is what the operator is doing. Then what the engine says of
 * the provider, with this client's last sign-in beside it: one that succeeded
 * is `finishing` until the engine has checked the provider again (unless
 * that success is `spent`), and one that failed says why on the signed-out
 * state. With no provider reported, as while J3 Bots starts, the account
 * stands where the server's copy of what it needs does (`fromCopy`): it can
 * sign in already when that is there, and otherwise says how far its
 * download is.
 */
export const aiAccountState = (account: AiAccount, facts: AiFacts): AiAccountState => {
  const signIn = facts.signIns.get(account);
  if (signIn?._tag === "starting") return { _tag: "signing-in", step: "opening", page: null };
  if (signIn?._tag === "waiting-for-browser") {
    return { _tag: "signing-in", step: "browser", page: signIn.url };
  }
  const provider = aiAccountProvider(facts.engine, account);
  const found =
    facts.locations?.some((location) => location.harness === account && location.path !== null) ===
    true;
  const copy = facts.engine?.harnesses?.[account];
  const reported: AiAccountState =
    provider !== undefined
      ? fromProvider(provider)
      : found
        ? { _tag: "sign-in", failed: null }
        : copy !== undefined
          ? fromCopy(account, copy)
          : { _tag: "preparing" };
  if (reported._tag !== "sign-in") return reported;
  if (signIn?._tag === "succeeded") {
    return facts.spent?.has(account) === true ? reported : { _tag: "finishing" };
  }
  return signIn?._tag === "failed" ? { _tag: "sign-in", failed: signIn.reason } : reported;
};

/** Every account's state. */
export const aiAccountStates = (facts: AiFacts): Readonly<Record<AiAccount, AiAccountState>> => ({
  "claude-code": aiAccountState("claude-code", facts),
  codex: aiAccountState("codex", facts),
});

/**
 * Whether an account is connected, or on its way there with nothing more
 * asked of the operator: signing in, signed in and being checked, or a
 * sign-in they asked for that waits for what it needs (`queued`). The first
 * run's Create leads then, since nothing is left to press on the account.
 */
export const aiOnItsWay = (state: AiAccountState, queued: boolean): boolean =>
  queued || state._tag === "ready" || state._tag === "finishing" || state._tag === "signing-in";

/**
 * What an account's one button does, in `state`, where it signs in at
 * `place`. Null when there is nothing for a button to do: it is connected,
 * a sign-in or a check is under way, or what stands in the way is not the
 * operator's to fix.
 * - `sign-in`: sign in, from this app. `queued` when it cannot start yet:
 *   what the account needs is still to download, downloading or being
 *   checked, so the client keeps the request, sees to the download, and
 *   starts the sign-in the moment it can (`queuedSignIn`);
 * - `download`: ask the server to download what the account needs, where
 *   this client does not sign in. `again` after a try that failed;
 * - `retry`: have the server check the account again;
 * - `look`: the operator installed it themselves, and the server looks again.
 */
export type AiAction =
  | { readonly _tag: "sign-in"; readonly queued: boolean; readonly again: boolean }
  | { readonly _tag: "download"; readonly again: boolean }
  | { readonly _tag: "retry" }
  | { readonly _tag: "look" };

export const aiAction = (state: AiAccountState, place: AiPlace): AiAction | null => {
  const here = place === "here";
  switch (state._tag) {
    case "sign-in":
      return here ? { _tag: "sign-in", queued: false, again: state.failed !== null } : null;
    case "missing":
      if (!state.canGet) return { _tag: "look" };
      // A download that failed is tried again on its own: the operator reads why first.
      if (state.failed !== null) return { _tag: "download", again: true };
      return here
        ? { _tag: "sign-in", queued: true, again: false }
        : { _tag: "download", again: false };
    case "getting":
    case "checking":
    case "preparing":
      return here ? { _tag: "sign-in", queued: true, again: false } : null;
    case "problem":
      return state.kind === "failed" || state.kind === "timed-out" ? { _tag: "retry" } : null;
    case "ready":
    case "finishing":
    case "signing-in":
      return null;
  }
};

/**
 * What becomes of a sign-in the operator asked for while it could not start
 * (`AiAction.queued`), now that the account is in `state`:
 * - `start`: the account is signed out with everything it needs;
 * - `download`: what it needs is not there and nothing is downloading it, so
 *   the client asks the server to, whichever state the request was made in;
 * - `keep`: it is downloading, being checked, or J3 Bots is still starting;
 * - `drop`: the account no longer needs a sign-in, or the download failed,
 *   which the operator reads and tries again themselves.
 */
export const queuedSignIn = (state: AiAccountState): "start" | "download" | "keep" | "drop" => {
  switch (state._tag) {
    case "sign-in":
      return "start";
    case "getting":
    case "checking":
    case "preparing":
      return "keep";
    case "missing":
      return state.canGet && state.failed === null ? "download" : "drop";
    case "ready":
    case "finishing":
    case "signing-in":
    case "problem":
      return "drop";
  }
};

/**
 * What keeps J3 Bots itself from running any account, whichever the operator
 * has: its engine is out, as `EngineStatus` says. Null while it runs or is
 * still starting, when each account says where it stands.
 */
export const aiOutage = (
  engine: EngineStatus | null,
): Exclude<EngineStatus["state"], { readonly _tag: "ready" | "starting" }> | null =>
  engine === null || engine.state._tag === "ready" || engine.state._tag === "starting"
    ? null
    : engine.state;

/**
 * Whether the first run's connect step says itself how far things are, so
 * the one quiet line under every step stays silent there instead of saying
 * it twice: J3 Bots is out, which the step says in its own words, or an
 * account's row shows its own download or check. While J3 Bots itself is
 * only still starting, the rows say just that, and the line says how far.
 */
export const connectStepSaysProgress = (engine: EngineStatus | null): boolean => {
  if (aiOutage(engine) !== null) return true;
  const facts: AiFacts = { engine, locations: null, signIns: new Map() };
  return aiAccounts.some((account) => {
    const { _tag } = aiAccountState(account, facts);
    return _tag === "getting" || _tag === "checking";
  });
};
