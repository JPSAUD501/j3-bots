// SPDX-License-Identifier: AGPL-3.0-or-later
import { Collapsible } from "@base-ui/react/collapsible";
import { runByDesktopApp, type ServerUpdateView } from "@j3-bots/client-runtime";
import {
  type AiAccount,
  aiAccountNames,
  aiAccounts,
  type AiPlace,
  otherAiAccount,
  type SignInStep,
  signInStepAt,
  signInSteps,
} from "@j3-bots/client-runtime/presentation";
import {
  type AiAccountModel,
  type AiConnectModel,
  useAiConnect,
} from "@j3-bots/client-runtime/react";
import {
  type AiAccountText,
  aiAccountText,
  aiActionLabel,
  type AiTone,
  signInStepLabel,
} from "@j3-bots/client-runtime/wording";
import type { EngineStatus, HarnessLocation } from "@j3-bots/contracts";
import {
  AppWindowIcon,
  CheckIcon,
  ChevronRightIcon,
  CornerDownLeftIcon,
  ExternalLinkIcon,
  type LucideIcon,
  MonitorIcon,
  TerminalIcon,
  UserRoundCheckIcon,
} from "lucide-react";
import type { ReactNode } from "react";
import { useI18n, usePresentation } from "../app/context";
import { cn } from "../lib/cn";
import { CommandLine } from "./CommandLine";
import type { ProviderActions } from "./ProviderFix";
import {
  EndpointForm,
  engineFindings,
  type LocalProviderSetup,
  useHarnesses,
} from "./ProviderSetup";
import { Button } from "./ui/button";

// Connecting an AI, as every screen of the web and the desktop app draws it:
// the first run's step, Settings, and a conversation whose bot waits for one
// (docs/decisions/0066-connecting-an-ai-is-picking-the-account-you-have.md).

/**
 * Where an AI account of the server this client talks to signs in: from
 * here, when the server runs on this computer; in the desktop app that runs
 * it, from another device; otherwise with a command, on the server's machine.
 */
export type ConnectPlace =
  | { readonly _tag: "here"; readonly setup: LocalProviderSetup }
  | { readonly _tag: "desktop-app" }
  | { readonly _tag: "server" };

/** Where the accounts connect, from what this client is: the app on the server's computer, or one that reaches it. */
export const connectPlaceOf = (
  setup: LocalProviderSetup | undefined,
  serverUpdate: ServerUpdateView | undefined,
): ConnectPlace =>
  setup !== undefined
    ? { _tag: "here", setup }
    : serverUpdate !== undefined && runByDesktopApp(serverUpdate)
      ? { _tag: "desktop-app" }
      : { _tag: "server" };

const noLocations = () => Promise.resolve<ReadonlyArray<HarnessLocation> | null>(null);

/** The accounts, and what this client knows of each, as one screen connects them. */
export interface WebAiConnect extends AiConnectModel {
  readonly engine: EngineStatus | null;
  /** The sign-ins and the endpoint, where this app runs them; undefined elsewhere. */
  readonly setup: LocalProviderSetup | undefined;
  readonly locations: ReadonlyArray<HarnessLocation> | null;
}

/**
 * The accounts as this screen connects them. A server that cannot run a
 * sign-in for a client, as one from before it could, is connected with the
 * command, on its machine.
 */
export function useWebAiConnect({
  engine,
  connect,
  actions,
}: {
  readonly engine: EngineStatus | null;
  readonly connect: ConnectPlace;
  readonly actions: ProviderActions;
}): WebAiConnect {
  const offered = connect._tag === "here" ? connect.setup : undefined;
  const unsupported =
    offered !== undefined &&
    [...offered.signIns.values()].some((view) => view._tag === "unsupported");
  const setup = unsupported ? undefined : offered;
  const place: AiPlace = setup !== undefined ? "here" : unsupported ? "server" : connect._tag;
  const { found } = useHarnesses(setup?.harnesses ?? noLocations, engineFindings(engine));
  const locations = found === "looking" ? null : found;
  const model = useAiConnect({
    facts: { engine, locations, signIns: setup?.signIns ?? new Map() },
    place,
    intents: {
      signIn: setup?.signIn ?? null,
      cancelSignIn: setup?.cancelSignIn ?? null,
      download: actions.install,
      cancelDownload: actions.cancelInstall,
      recheck: actions.recheck,
    },
  });
  return { ...model, engine, setup, locations };
}

const toneClass = {
  ready: "text-success",
  waiting: "text-foreground",
  blocked: "text-blocked",
  muted: "text-muted-foreground",
} as const satisfies Record<AiTone, string>;

/** An account's words, for the state it is in on this screen. */
export function useAiText(ai: WebAiConnect, account: AiAccountModel): AiAccountText {
  return aiAccountText(
    account.account,
    account.state,
    {
      engine: ai.engine,
      place: ai.place,
      signIn: ai.setup?.signIns.get(account.account),
      queued: account.queued,
    },
    usePresentation(),
  );
}

/**
 * The question the first screen asks: which AI the operator has. One large
 * button each, with a mark on the one already connected or on its way.
 */
export function AiChoice({ ai }: { ai: WebAiConnect }) {
  const { t } = useI18n();
  return (
    <div className="flex w-full flex-col gap-3">
      <ul aria-label={t("ai.choice.label")} className="flex w-full flex-col gap-2">
        {aiAccounts.map((account) => {
          const { name, maker, product } = aiAccountNames[account];
          const { state } = ai.accounts[account];
          return (
            <li key={account}>
              <button
                type="button"
                onClick={() => ai.open(account)}
                className="pressable flex min-h-18 w-full items-center gap-3 rounded-lg border border-input bg-surface px-4 py-3 text-start hover:bg-muted"
              >
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="text-lg font-semibold">{name}</span>
                  <span className="text-sm text-muted-foreground">
                    {t("ai.by", { maker })} · {product}
                  </span>
                </span>
                {state._tag === "ready" ? (
                  <CheckIcon aria-hidden className="size-5 text-success" />
                ) : (
                  <ChevronRightIcon
                    aria-hidden
                    className="size-5 text-muted-foreground rtl:-scale-x-100"
                  />
                )}
              </button>
            </li>
          );
        })}
      </ul>
      <p className="text-center text-xs text-pretty text-muted-foreground">{t("ai.plan")}</p>
    </div>
  );
}

const stepIcons = {
  here: AppWindowIcon,
  "desktop-app": MonitorIcon,
  server: TerminalIcon,
} as const satisfies Record<AiPlace, LucideIcon>;

/**
 * The sign-in, drawn: a page opens, the operator signs in, and they come
 * back. The step under way stands out and breathes; those behind it are
 * checked. Before a sign-in starts, the three are only what is to come.
 */
function SignInSteps({
  account,
  at,
  place,
}: {
  account: AiAccount;
  at: SignInStep | "done" | null;
  place: AiPlace;
}) {
  const i18n = useI18n();
  const reached = at === null ? -1 : at === "done" ? signInSteps.length : signInSteps.indexOf(at);
  const icons: Record<SignInStep, LucideIcon> = {
    page: stepIcons[place],
    "sign-in": UserRoundCheckIcon,
    back: CornerDownLeftIcon,
  };
  return (
    <ol aria-label={i18n.t("ai.steps.label")} className="flex w-full items-start">
      {signInSteps.map((step, index) => {
        const Icon = index < reached ? CheckIcon : icons[step];
        const current = index === reached;
        return (
          <li
            key={step}
            aria-current={current ? "step" : undefined}
            className="relative flex min-w-0 flex-1 flex-col items-center gap-2 text-center"
          >
            {index > 0 && (
              <span
                aria-hidden
                className={cn(
                  "absolute end-1/2 top-5.5 -z-0 h-px w-full",
                  index <= reached ? "bg-foreground" : "bg-border",
                )}
              />
            )}
            <span
              className={cn(
                "relative z-10 flex size-11 items-center justify-center rounded-pill border bg-background",
                current
                  ? "border-foreground text-foreground"
                  : index < reached
                    ? "border-success text-success"
                    : "border-border text-muted-foreground",
              )}
            >
              <Icon
                aria-hidden
                className={cn(
                  "size-5",
                  current &&
                    "animate-[onboarding-pulse_1.6s_ease-in-out_infinite] motion-reduce:animate-none",
                )}
              />
            </span>
            <span
              className={cn(
                "px-1 text-xs text-pretty",
                current ? "font-medium text-foreground" : "text-muted-foreground",
              )}
            >
              {signInStepLabel(step, account, place, i18n)}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

/**
 * How far something is, quietly: a thin bar that fills as it goes, or, when
 * how far is not known, one that breathes. `label` is what a screen reader
 * hears it is.
 */
function Progress({ value, label }: { value: number | null; label: string }) {
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={value === null ? undefined : Math.round(value * 100)}
      className="h-1.5 w-full overflow-hidden rounded-pill bg-muted"
    >
      <div
        className={cn(
          "h-full rounded-pill bg-foreground transition-[width] duration-(--duration-soft) ease-soft",
          value === null &&
            "animate-[onboarding-pulse_1.6s_ease-in-out_infinite] opacity-60 motion-reduce:animate-none",
        )}
        style={{ width: value === null ? "100%" : `${Math.max(4, value * 100)}%` }}
      />
    </div>
  );
}

/** What was said, as it was said, folded away under "Details" until the operator asks. */
export function AiDetails({ children }: { children: ReactNode }) {
  const { t } = useI18n();
  return (
    <Collapsible.Root className="w-full text-start">
      <Collapsible.Trigger className="pressable group -ms-2 flex min-h-8 items-center gap-1.5 rounded-md px-2 text-xs text-muted-foreground hover:bg-muted hover:text-foreground">
        <ChevronRightIcon
          aria-hidden
          className="size-3.5 transition-transform duration-(--duration-pop) ease-pop group-data-panel-open:rotate-90 rtl:-scale-x-100"
        />
        {t("ai.details")}
      </Collapsible.Trigger>
      <Collapsible.Panel className="h-(--collapsible-panel-height) overflow-hidden transition-[height,opacity] duration-(--duration-slide) ease-slide data-ending-style:h-0 data-ending-style:opacity-0 data-starting-style:h-0 data-starting-style:opacity-0">
        <div className="flex flex-col gap-1.5 pt-1 pb-1 text-xs break-words text-muted-foreground">
          {children}
        </div>
      </Collapsible.Panel>
    </Collapsible.Root>
  );
}

/** How far a state is, for the bar; `undefined` for a state that shows none. */
const progressOf = (account: AiAccountModel): number | null | undefined => {
  const { state } = account;
  switch (state._tag) {
    case "getting":
    case "preparing":
      return state.progress;
    case "checking":
    case "finishing":
      return null;
    case "missing":
      // Asked for, and about to start.
      return account.queued ? null : undefined;
    case "ready":
    case "signing-in":
    case "sign-in":
    case "problem":
      return undefined;
  }
};

/**
 * One account, whole: where it stands, the sign-in drawn while it is the
 * way forward, calm progress while something downloads, and what went wrong
 * with what to do next. `said` is the sentence a screen already says in its
 * own type, as the first run's step does, so it is not repeated here;
 * `button` leaves the account's one button to a screen that draws it itself.
 */
export function AiAccountPanel({
  ai,
  account,
  said = null,
  button = true,
  align = "center",
}: {
  ai: WebAiConnect;
  account: AiAccountModel;
  said?: "line" | "hint" | null;
  button?: boolean;
  /**
   * `start` in a list, as Settings', where the account is one of several:
   * the sign-in is drawn only once it is under way, and the details also say
   * where the server finds what the account runs. Centered where the account
   * has the screen.
   */
  align?: "center" | "start";
}) {
  const i18n = useI18n();
  const { t } = i18n;
  const text = useAiText(ai, account);
  const { state, action } = account;
  const { product } = aiAccountNames[account.account];
  const at = signInStepAt(state);
  const progress = progressOf(account);
  // The sign-in is drawn while it is under way, and before it, where the account has the screen.
  const listed = align === "start";
  const drawn =
    state._tag === "signing-in" ||
    state._tag === "finishing" ||
    (!listed && state._tag === "sign-in" && state.failed === null);
  const path = listed
    ? (ai.locations?.find((location) => location.harness === account.account)?.path ?? null)
    : null;
  const stoppable = state._tag === "getting";
  return (
    <div
      className={cn(
        "flex w-full flex-col gap-3",
        align === "center" ? "items-center text-center" : "items-start text-start",
      )}
    >
      {state._tag === "ready" && align === "center" && (
        <span className="pop-in flex size-14 items-center justify-center rounded-pill bg-success text-background">
          <CheckIcon aria-hidden className="size-7" />
        </span>
      )}
      {said === null && (
        <p role="status" className={cn("text-sm text-pretty", toneClass[text.tone])}>
          {text.line}
        </p>
      )}
      {drawn && <SignInSteps account={account.account} at={at} place={ai.place} />}
      {progress !== undefined && <Progress value={progress} label={text.line} />}
      {text.hint !== null && said !== "hint" && (
        <p className="text-sm text-pretty text-muted-foreground">{text.hint}</p>
      )}
      {account.queued && (
        <Button variant="ghost-muted" size="sm" onClick={account.cancel}>
          {t("ai.cancel")}
        </Button>
      )}
      {text.command !== null && (
        <div className="w-full text-start">
          <CommandLine command={text.command} copyLabel={t("ai.copyCommand")} large />
        </div>
      )}
      {state._tag === "signing-in" && (
        <div className="flex flex-wrap items-center gap-2">
          {state.page !== null && (
            <Button
              variant="secondary"
              size="sm"
              render={<a href={state.page} target="_blank" rel="noreferrer" />}
            >
              <ExternalLinkIcon aria-hidden className="size-3.5" />
              {t("ai.openAgain")}
            </Button>
          )}
          <Button variant="ghost-muted" size="sm" onClick={account.cancel}>
            {t("ai.cancel")}
          </Button>
        </div>
      )}
      {state._tag === "missing" && state.page !== null && (
        <Button
          variant="secondary"
          size="sm"
          render={<a href={state.page} target="_blank" rel="noreferrer" />}
        >
          <ExternalLinkIcon aria-hidden className="size-3.5" />
          {t("ai.howToInstall", { product })}
        </Button>
      )}
      {button && action !== null && (
        <Button
          variant={state._tag === "missing" && !state.canGet ? "secondary" : "primary"}
          className="h-11 w-full"
          disabled={account.asking === "asking"}
          onClick={account.act}
        >
          {aiActionLabel(action, account.account, i18n)}
        </Button>
      )}
      {account.asking === "failed" && (
        <p role="alert" className="text-xs text-blocked">
          {t("ai.requestFailed")}
        </p>
      )}
      {(text.details.length > 0 || path !== null || stoppable) && (
        <AiDetails>
          {text.details.map((detail) => (
            <p key={detail} className="select-text">
              {detail}
            </p>
          ))}
          {path !== null && (
            <p className="break-all select-text">{t("ai.details.found", { product, path })}</p>
          )}
          {stoppable && (
            <Button
              variant="ghost-muted"
              size="sm"
              className="self-start"
              disabled={account.asking === "asking"}
              onClick={account.stopDownload}
            >
              {t("ai.stopDownload")}
            </Button>
          )}
        </AiDetails>
      )}
    </div>
  );
}

/**
 * An endpoint instead of an account, for those who run a proxy in front of
 * their subscriptions: one quiet "Advanced", folded, at the foot of the
 * screen, in the app on the server's own computer. Never offered as what to
 * do about an error: what a layperson does next is always their account's
 * own button.
 */
export function AdvancedEndpoint({ ai }: { ai: WebAiConnect }) {
  const { t } = useI18n();
  if (ai.setup === undefined) return null;
  return (
    <Collapsible.Root className="w-full text-start">
      <Collapsible.Trigger className="pressable group -ms-2 flex min-h-8 items-center gap-1.5 rounded-md px-2 text-xs text-muted-foreground hover:bg-muted hover:text-foreground">
        <ChevronRightIcon
          aria-hidden
          className="size-3.5 transition-transform duration-(--duration-pop) ease-pop group-data-panel-open:rotate-90 rtl:-scale-x-100"
        />
        {t("providers.endpoint.open")}
      </Collapsible.Trigger>
      <Collapsible.Panel className="h-(--collapsible-panel-height) overflow-hidden transition-[height,opacity] duration-(--duration-slide) ease-slide data-ending-style:h-0 data-ending-style:opacity-0 data-starting-style:h-0 data-starting-style:opacity-0">
        <EndpointForm onConnect={ai.setup.connectEndpoint} />
      </Collapsible.Panel>
    </Collapsible.Root>
  );
}

/** The way from one account to the other: a wrong turn has an obvious way back. */
export function OtherAccount({ ai, account }: { ai: WebAiConnect; account: AiAccount }) {
  const { t } = useI18n();
  const other = otherAiAccount(account);
  return (
    <Button variant="ghost-muted" size="sm" onClick={() => ai.open(other)}>
      {t("ai.other", { account: aiAccountNames[other].name })}
    </Button>
  );
}

/**
 * Connecting an AI, in one place: the question, which one the operator has,
 * then that account alone, with the other one press away. For a screen that
 * is not the first run's step, as a conversation whose bot waits for its AI.
 */
export function AiConnect({ ai }: { ai: WebAiConnect }) {
  const { opened } = ai;
  return (
    <div className="flex w-full flex-col items-center gap-3">
      {opened === null ? (
        <AiChoice ai={ai} />
      ) : (
        <>
          <span className="font-semibold">{aiAccountNames[opened.account].name}</span>
          <AiAccountPanel ai={ai} account={opened} />
          <OtherAccount ai={ai} account={opened.account} />
        </>
      )}
      <AdvancedEndpoint ai={ai} />
    </div>
  );
}

/**
 * One account as Settings lists it: its name and maker, then the account
 * whole (`AiAccountPanel`), with `children` after it, as its version.
 */
export function AiAccountCard({
  ai,
  account,
  stale = false,
  children,
}: {
  ai: WebAiConnect;
  account: AiAccount;
  /** A state reported before a disconnection: said, muted, with nothing to press. */
  stale?: boolean;
  children?: ReactNode;
}) {
  const { t } = useI18n();
  const { name, maker } = aiAccountNames[account];
  const text = useAiText(ai, ai.accounts[account]);
  return (
    <li className="flex flex-col gap-3 rounded-md border border-border px-3 py-3">
      <div className="flex flex-wrap items-baseline gap-x-2">
        <span className="text-sm font-semibold">{name}</span>
        <span className="text-xs text-muted-foreground">{t("ai.by", { maker })}</span>
      </div>
      {stale ? (
        <p className="text-sm text-muted-foreground">{text.line}</p>
      ) : (
        <>
          <AiAccountPanel ai={ai} account={ai.accounts[account]} align="start" />
          {children}
        </>
      )}
    </li>
  );
}
