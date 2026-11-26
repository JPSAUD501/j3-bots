// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  type EngineStatus,
  type HarnessInstallFailure,
  type SignInFailure,
  signInCommands,
} from "@j3-bots/contracts";
import type { I18n } from "@j3-bots/i18n";
import {
  type AiAccount,
  aiAccountNames,
  aiAccountProvider,
  type AiAccountState,
  type AiAction,
  aiOutage,
  type AiPlace,
  type SignInStep,
} from "../presentation/aiAccount.ts";
import { hasDefaultModel, providerDetail } from "../presentation/engine.ts";
import type { SignInView } from "../stores/ProviderSetup.ts";
import { engineProblem, harnessFailureText } from "./engine.ts";
import { usageLimitText } from "./status.ts";
import type { TimeContext } from "./time.ts";

// Connecting an AI, in the operator's words: the account they have, what is
// happening to it, and what they do next. Nothing here names the harness,
// the engine or a path; what the engine or a harness said is kept for
// `details`, which a screen folds away.

/** How an account's line is drawn: connected, under way, stopped by something, or at rest. */
export type AiTone = "ready" | "waiting" | "blocked" | "muted";

/**
 * One account, in words:
 * - `line`: where it stands, in one sentence;
 * - `hint`: what the operator does next, or what happens next by itself;
 *   null when the line and the button say it;
 * - `command`: the one command that signs it in, to run on the machine J3
 *   Bots is installed on, where this client cannot sign it in;
 * - `details`: what the engine or the sign-in said, as they said it, and
 *   where to read more: for a "Details" a screen keeps folded.
 */
export interface AiAccountText {
  readonly line: string;
  readonly tone: AiTone;
  readonly hint: string | null;
  readonly command: string | null;
  readonly details: ReadonlyArray<string>;
}

/** What `aiAccountText` reads beside the account's state. */
export interface AiAccountContext {
  readonly engine: EngineStatus | null;
  readonly place: AiPlace;
  /** This client's sign-in of the account, if it follows one. */
  readonly signIn: SignInView | undefined;
  /** Whether the operator asked to sign in while the account could not yet (`AiAction.queued`). */
  readonly queued: boolean;
}

/** A whole percentage of a part from 0 to 1. */
const percent = (part: number): number => Math.round(part * 100);

export function aiAccountText(
  account: AiAccount,
  state: AiAccountState,
  context: AiAccountContext,
  ctx: TimeContext,
): AiAccountText {
  const { i18n } = ctx;
  const { t } = i18n;
  const { name, product } = aiAccountNames[account];
  const { place, signIn } = context;
  const provider = aiAccountProvider(context.engine, account);
  // The engine's own words, which it does not give of a harness J3 Bots installs itself.
  const engineSaid = provider === undefined ? null : providerDetail(provider);
  const said = engineSaid === null ? [] : [engineSaid];
  const plain = { hint: null, command: null, details: [] } as const;
  switch (state._tag) {
    case "ready":
      return {
        ...plain,
        line: t("ai.ready", { account: name }),
        tone: "ready",
        hint: state.limit === null ? null : usageLimitText(state.limit.resetsAt, ctx),
      };
    case "finishing":
      return {
        ...plain,
        line: t("ai.finishing", { account: name }),
        tone: "waiting",
        hint:
          signIn?._tag === "succeeded" && signIn.endpoint !== null
            ? t("ai.finishing.endpoint", { endpoint: signIn.endpoint })
            : null,
      };
    case "signing-in":
      return state.step === "opening"
        ? { ...plain, line: t("ai.signingIn.opening"), tone: "waiting" }
        : {
            ...plain,
            line: t("ai.signingIn.browser", { account: name }),
            tone: "waiting",
            hint: t("ai.signingIn.notices"),
          };
    case "getting":
      return {
        ...plain,
        line: gettingLine(state, name, i18n),
        tone: "waiting",
        hint: context.queued ? t("ai.queued") : null,
      };
    case "sign-in":
      if (state.failed !== null) {
        return {
          ...plain,
          line: signInFailureLine(state.failed, name, i18n),
          tone: "blocked",
          details: [signInFailureDetail(state.failed, product, i18n)],
        };
      }
      return {
        ...plain,
        line: t("ai.signedOut"),
        tone: "muted",
        hint:
          place === "here"
            ? null
            : t(place === "desktop-app" ? "ai.signedOut.desktopApp" : "ai.signedOut.server"),
        command: place === "server" ? signInCommands[account] : null,
      };
    case "missing":
      if (!state.canGet) {
        return {
          ...plain,
          line: t(place === "here" ? "ai.missing.cannotGet.here" : "ai.missing.cannotGet.server", {
            account: name,
          }),
          tone: "waiting",
          hint: t("ai.missing.cannotGet.hint", { product }),
          details: said,
        };
      }
      return state.failed === null
        ? {
            ...plain,
            line: t("ai.missing"),
            tone: "muted",
            hint: context.queued ? t("ai.queued") : null,
          }
        : downloadFailed(state.failed, name, product, said, i18n);
    case "checking":
      return {
        ...plain,
        line: t("ai.checking", { account: name }),
        tone: "waiting",
        hint: context.queued ? t("ai.queued") : null,
      };
    case "problem":
      return problemText(state.kind, name, place, said, i18n);
    case "preparing":
      return {
        ...plain,
        line:
          state.progress === null
            ? t("ai.preparing")
            : t("ai.preparing.progress", { percent: percent(state.progress) }),
        tone: "waiting",
        hint: context.queued ? t("ai.queued") : null,
      };
  }
}

/**
 * A first download that did not finish, said of the account. The server's
 * own sentence is what the operator reads, except where it speaks a
 * mechanic's language (a checksum, the engine) or of a copy before this one,
 * which a first download does not have: those are said plainly here, with
 * the server's sentence kept for the details.
 */
function downloadFailed(
  reason: HarnessInstallFailure,
  account: string,
  product: string,
  said: ReadonlyArray<string>,
  i18n: I18n,
): AiAccountText {
  const { t } = i18n;
  const servers = harnessFailureText(reason, i18n);
  const plain =
    reason === "checksum"
      ? t("ai.missing.failed.checksum")
      : reason === "engine"
        ? t("ai.missing.failed.engine", { account })
        : null;
  return {
    line: plain ?? servers,
    tone: "blocked",
    hint: null,
    command: null,
    details: [
      t("ai.details.download", { product, reason }),
      ...(plain === null ? [] : [servers]),
      ...said,
    ],
  };
}

function gettingLine(
  state: Extract<AiAccountState, { readonly _tag: "getting" }>,
  account: string,
  { t }: I18n,
): string {
  switch (state.task) {
    case "downloading":
      return state.progress === null
        ? t("ai.getting", { account })
        : t("ai.getting.progress", { account, percent: percent(state.progress) });
    case "verifying":
      return t("ai.getting.verifying");
    case "waiting":
      return t("provider.install.waiting");
  }
}

function problemText(
  kind: Extract<AiAccountState, { readonly _tag: "problem" }>["kind"],
  account: string,
  place: AiPlace,
  said: ReadonlyArray<string>,
  { t }: I18n,
): AiAccountText {
  switch (kind) {
    case "failed":
      return {
        line: t("ai.problem.failed", { account }),
        tone: "blocked",
        hint: t("ai.problem.failed.hint"),
        command: null,
        // On this computer, the server's log is one press away.
        details: place === "here" ? [...said, t("provider.failed.log")] : said,
      };
    case "timed-out":
      return {
        line: t("ai.problem.timedOut", { account }),
        tone: "waiting",
        hint: null,
        command: null,
        details: said,
      };
    case "off":
      return {
        line: t("ai.problem.off", { account }),
        tone: "muted",
        hint: null,
        command: null,
        details: said,
      };
    case "unknown":
      return {
        line: t("ai.problem.unknown", { account }),
        tone: "muted",
        hint: null,
        command: null,
        details: said,
      };
  }
}

/** Why a sign-in ended without signing in, in a sentence anyone reads; a reason this client does not know is a plain failure. */
function signInFailureLine(
  reason: SignInFailure | "unknown",
  account: string,
  { t }: I18n,
): string {
  switch (reason) {
    case "not-installed":
      return t("ai.signIn.failed.notInstalled", { account });
    case "needs-terminal":
      return t("ai.signIn.failed.needsTerminal", { account });
    case "ended":
      return t("ai.signIn.failed.ended");
    case "no-credential":
      return t("ai.signIn.failed.noCredential", { account });
    case "linked-home":
    case "home-refused":
      return t("ai.signIn.failed.home");
    case "timed-out":
      return t("ai.signIn.failed.timedOut");
    case "unexpected":
    case "unknown":
      return t("ai.signIn.failed.other");
  }
}

/** The same ending as whoever repairs it reads it, naming the product and what stood in the way. */
function signInFailureDetail(
  reason: SignInFailure | "unknown",
  product: string,
  { t }: I18n,
): string {
  switch (reason) {
    case "not-installed":
      return t("ai.signIn.details.notInstalled", { product });
    case "needs-terminal":
      return t("ai.signIn.details.needsTerminal", { product });
    case "ended":
      return t("ai.signIn.details.ended", { product });
    case "no-credential":
      return t("ai.signIn.details.noCredential", { product });
    case "linked-home":
      return t("ai.signIn.details.linkedHome", { product });
    case "home-refused":
      return t("ai.signIn.details.homeRefused", { product });
    case "timed-out":
      return t("ai.signIn.details.timedOut", { product });
    case "unexpected":
    case "unknown":
      return t("ai.signIn.details.other", { product });
  }
}

/** What an account's one button says. */
export function aiActionLabel(action: AiAction, account: AiAccount, { t }: I18n): string {
  const { name } = aiAccountNames[account];
  switch (action._tag) {
    case "sign-in":
      return action.again ? t("ai.tryAgain") : t("ai.signIn", { account: name });
    case "download":
      return action.again ? t("ai.tryAgain") : t("ai.download", { account: name });
    case "retry":
      return t("ai.tryAgain");
    case "look":
      return t("ai.lookAgain");
  }
}

/**
 * One of the sign-in's three steps, in a few words, where the account signs
 * in at `place`: only the first differs, since it is where the operator
 * starts.
 */
export function signInStepLabel(
  step: SignInStep,
  account: AiAccount,
  place: AiPlace,
  { t }: I18n,
): string {
  switch (step) {
    case "page":
      return t(
        place === "here"
          ? "ai.steps.page.here"
          : place === "desktop-app"
            ? "ai.steps.page.desktopApp"
            : "ai.steps.page.server",
      );
    case "sign-in":
      return t("ai.steps.signIn", { account: aiAccountNames[account].name });
    case "back":
      return t("ai.steps.back");
  }
}

/**
 * The first run's connect step, in words, for the bot named `name`:
 * - `title` and `body`: with no account opened, the question, which AI the
 *   operator has; with one, where it stands. When J3 Bots itself cannot run
 *   any (`aiOutage`), that it cannot, whether it is coming back by itself,
 *   and what the operator can do when its own install failed on a full disk
 *   or a file another program held;
 * - `says`: which of the account's own sentences the body already is, so the
 *   screen does not repeat it under itself: its `line`, its `hint`, or
 *   neither;
 * - `details`: what J3 Bots itself says of an engine that is out, in its own
 *   words, for the step's "Details"; empty otherwise;
 * - `later`, while the bot can be created before its AI is connected, says
 *   so; null once one is, and while the server has no model to give the bot;
 * - `createWaits`, while the server has no model to give the bot, so
 *   creating it would only be refused: why Create waits. That is while J3
 *   Bots is still starting or is out, when it lists no AI, and while no
 *   account it lists can take a bot, as one that failed to start beside one that lists
 *   no model until it is connected. Null while Create can be pressed, and
 *   before the server answers at all, when a client waits for it to create
 *   the bot.
 */
export interface ConnectStepText {
  readonly title: string;
  readonly body: string;
  readonly says: "line" | "hint" | null;
  readonly details: ReadonlyArray<string>;
  readonly later: string | null;
  readonly createWaits: string | null;
}

export function connectStepText(
  engine: EngineStatus | null,
  opened: { readonly account: AiAccount; readonly text: AiAccountText } | null,
  state: AiAccountState | null,
  name: string,
  i18n: I18n,
): ConnectStepText {
  const { t } = i18n;
  const canCreate = hasDefaultModel(engine);
  // While J3 Bots starts, it lists no AI yet, and while it is out, none either;
  // once it runs, none it lists can take a bot.
  const createWaits =
    engine === null || canCreate
      ? null
      : t(
          engine.state._tag === "ready"
            ? "onboarding.connect.createWaits.none"
            : engine.state._tag === "starting"
              ? "onboarding.connect.createWaits"
              : "onboarding.connect.createWaits.out",
          { name },
        );
  const connected = state?._tag === "ready";
  const later = canCreate && !connected ? t("onboarding.connect.later", { name }) : null;
  const rest = { details: [], later, createWaits } as const;
  const outage = aiOutage(engine);
  if (engine !== null && outage !== null) {
    const problem = engineProblem(engine, i18n);
    // Restarting is J3 Bots' own to do, and soon over; so is trying its own
    // install again, where two reasons are the operator's to act on, in the
    // server's own plain words. Anything else needs someone at the machine.
    const reason = outage._tag === "unavailable" ? outage.reason : null;
    const mine =
      reason === "down" ? "restarting" : reason === "install-failed" ? "setup" : ("out" as const);
    const actionable =
      outage._tag === "unavailable" &&
      (outage.installFailure === "storage" || outage.installFailure === "in-use");
    return {
      ...rest,
      title: t(`onboarding.connect.${mine}.title`),
      body:
        mine === "setup" && actionable && problem !== null
          ? problem.body
          : t(`onboarding.connect.${mine}.body`),
      says: null,
      details: problem === null ? [] : [problem.title, problem.body],
    };
  }
  if (opened === null || state === null) {
    return {
      ...rest,
      title: t("onboarding.connect.choice.title", { name }),
      body: t("onboarding.connect.choice.body"),
      says: null,
    };
  }
  const title = stepTitle(state, aiAccountNames[opened.account].name, i18n);
  if (connected) {
    return { ...rest, title, body: t("onboarding.connect.ready.body", { name }), says: "line" };
  }
  // A signed-out account's line only says so, which the title already does:
  // the body is what the operator does about it.
  if (state._tag === "sign-in" && state.failed === null) {
    return {
      ...rest,
      title,
      body: opened.text.hint ?? t("onboarding.connect.signIn.body"),
      says: "hint",
    };
  }
  return { ...rest, title, body: opened.text.line, says: "line" };
}

function stepTitle(state: AiAccountState, account: string, { t }: I18n): string {
  switch (state._tag) {
    case "ready":
      return t("onboarding.connect.ready.title", { account });
    case "finishing":
      return t("onboarding.connect.finishing.title");
    case "signing-in":
      return t("onboarding.connect.signIn.title", { account });
    case "sign-in":
      return state.failed === null
        ? t("onboarding.connect.signIn.title", { account })
        : t("onboarding.connect.failed.title");
    case "getting":
    case "checking":
    case "preparing":
      return t("onboarding.connect.getting.title", { account });
    case "missing":
      return state.canGet && state.failed === null
        ? t("onboarding.connect.getting.title", { account })
        : t("onboarding.connect.stuck.title", { account });
    case "problem":
      return t("onboarding.connect.stuck.title", { account });
  }
}
