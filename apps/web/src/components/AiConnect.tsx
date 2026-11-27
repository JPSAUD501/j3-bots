// SPDX-License-Identifier: AGPL-3.0-or-later
import { Collapsible } from "@base-ui/react/collapsible";
import { firstAccountOf, runByDesktopApp, type ServerUpdateView } from "@j3-bots/client-runtime";
import {
  type AiAccount,
  aiAccountNames,
  aiAccounts,
  type AiPlace,
} from "@j3-bots/client-runtime/presentation";
import {
  type AiAccountModel,
  type AiConnectModel,
  useAiConnect,
} from "@j3-bots/client-runtime/react";
import {
  aiAccountName,
  type AiAccountText,
  aiAccountText,
  aiActionLabel,
  type AiTone,
} from "@j3-bots/client-runtime/wording";
import type { EngineStatus, HarnessLocation } from "@j3-bots/contracts";
import { CheckIcon, ChevronRightIcon, ExternalLinkIcon } from "lucide-react";
import { type ReactNode, useState } from "react";
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
// the first run's step, Settings, and a conversation whose bot waits for one.
// Each account is one row whose status line carries the one thing that moves
// it forward (docs/decisions/0085-signing-in-is-one-row-and-the-browser-opens-by-itself.md).

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

/** What the hooks that connect an account take, on this screen. */
type AiConnectInput = Parameters<typeof useAiConnect>[0];

/** The accounts, and what this client knows of each, as one screen connects them. */
export interface WebAiConnect extends AiConnectModel {
  /** What connecting any account the operator set up takes, as `useAiAccountModel` reads it. */
  readonly input: AiConnectInput;
  readonly engine: EngineStatus | null;
  /** The sign-ins and the endpoint, where this app runs them; undefined elsewhere. */
  readonly setup: LocalProviderSetup | undefined;
  readonly locations: ReadonlyArray<HarnessLocation> | null;
}

/** The accounts as this screen connects them, where `connect` says they sign in. */
export function useWebAiConnect({
  engine,
  connect,
  actions,
}: {
  readonly engine: EngineStatus | null;
  readonly connect: ConnectPlace;
  readonly actions: ProviderActions;
}): WebAiConnect {
  const setup = connect._tag === "here" ? connect.setup : undefined;
  const place: AiPlace = connect._tag;
  const { found } = useHarnesses(setup?.harnesses ?? noLocations, engineFindings(engine));
  const locations = found === "looking" ? null : found;
  const input: AiConnectInput = {
    facts: { engine, locations, signIns: setup?.signIns ?? new Map() },
    place,
    intents: {
      signIn: setup?.signIn ?? null,
      cancelSignIn: setup?.cancelSignIn ?? null,
      download: actions.install,
      cancelDownload: actions.cancelInstall,
      recheck: actions.recheck,
    },
  };
  const model = useAiConnect(input);
  return { ...model, input, engine, setup, locations };
}

const toneClass = {
  ready: "text-success",
  waiting: "text-foreground",
  blocked: "text-blocked",
  muted: "text-muted-foreground",
} as const satisfies Record<AiTone, string>;

/** An account's words, for the state it is in on this screen. */
function useAiText(ai: WebAiConnect, account: AiAccountModel): AiAccountText {
  return aiAccountText(
    account.account,
    account.state,
    {
      engine: ai.engine,
      place: ai.place,
      signIn: ai.setup?.signIns.get(account.account.providerId),
      queued: account.queued,
    },
    usePresentation(),
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
    case "preparing":
      return undefined;
  }
};

/** A quiet link out of the app, to a page in the system's browser. */
function PageLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="pressable -ms-1 inline-flex min-h-8 items-center gap-1.5 self-start rounded-md px-1 text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
    >
      <ExternalLinkIcon aria-hidden className="size-3.5" />
      {children}
    </a>
  );
}

/**
 * One AI account, as one row: its name, and under it the line that says
 * where it stands, with the one thing that moves it forward right beside
 * that line: "Sign in with Claude" while it is not connected, Cancel while it
 * signs in, Try again after something went wrong. What the operator reads
 * only when they need it sits under the row: how far a download is, where to
 * sign in from another device, the page again when the browser did not open,
 * and the details, folded. `children`, as the version it runs, shows only
 * once it is connected. `paths` adds where the server finds what it runs to
 * its details, for Settings. `stale` is a state reported before a
 * disconnection: said, muted, with nothing to press. `setup`, in Settings,
 * is what the operator sets up of the account, under the rest whatever its
 * state.
 */
export function AiAccountRow({
  ai,
  model,
  paths = false,
  stale = false,
  children,
  setup,
}: {
  ai: WebAiConnect;
  model: AiAccountModel;
  paths?: boolean;
  stale?: boolean;
  children?: ReactNode;
  setup?: ReactNode;
}) {
  const i18n = useI18n();
  const { t } = i18n;
  const text = useAiText(ai, model);
  const [howOpen, setHowOpen] = useState(false);
  const { state, action } = model;
  const { harness } = model.account;
  const { maker, product } = aiAccountNames[harness];
  const name = aiAccountName(ai.engine, model.account);
  // From another device, a signed-out account says where it signs in only when asked.
  const elsewhere = ai.place !== "here" && state._tag === "sign-in" && state.failed === null;
  const progress = progressOf(model);
  // Where the server finds the harness: what the first account of it runs.
  const path =
    paths && model.account.providerId === firstAccountOf(harness).providerId
      ? (ai.locations?.find((location) => location.harness === harness)?.path ?? null)
      : null;
  const stoppable = state._tag === "getting";
  const trailing = stale ? null : state._tag === "ready" ? (
    <CheckIcon aria-hidden className="size-5 text-success" />
  ) : action !== null ? (
    <Button
      variant={state._tag === "missing" && !state.canGet ? "secondary" : "primary"}
      disabled={model.asking === "asking"}
      onClick={model.act}
    >
      {aiActionLabel(action, name, i18n)}
    </Button>
  ) : state._tag === "signing-in" || model.queued ? (
    <Button variant="ghost-muted" size="sm" onClick={model.cancel}>
      {t("ai.cancel")}
    </Button>
  ) : elsewhere ? (
    <Button
      variant="secondary"
      size="sm"
      aria-expanded={howOpen}
      onClick={() => setHowOpen((now) => !now)}
    >
      {t("ai.howToConnect")}
    </Button>
  ) : null;
  return (
    <li className="flex flex-col gap-2 rounded-lg border border-border bg-surface px-3 py-3 text-start">
      <div className="flex min-h-11 items-center gap-3">
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <p className="flex flex-wrap items-baseline gap-x-2">
            <span className="text-sm font-semibold">{name}</span>
            <span className="text-xs text-muted-foreground">{t("ai.by", { maker })}</span>
          </p>
          <p
            role="status"
            className={cn(
              "text-sm text-pretty",
              stale ? "text-muted-foreground" : toneClass[text.tone],
            )}
          >
            {text.line}
          </p>
        </div>
        {trailing}
      </div>
      {!stale && (
        <>
          {progress !== undefined && <Progress value={progress} label={text.line} />}
          {text.hint !== null && (!elsewhere || howOpen) && (
            <p className="text-sm text-pretty text-muted-foreground">{text.hint}</p>
          )}
          {text.command !== null && howOpen && (
            <CommandLine command={text.command} copyLabel={t("ai.copyCommand")} large />
          )}
          {state._tag === "signing-in" && state.page !== null && (
            <PageLink href={state.page}>{t("ai.openPage")}</PageLink>
          )}
          {state._tag === "missing" && state.page !== null && (
            <PageLink href={state.page}>{t("ai.howToInstall", { product })}</PageLink>
          )}
          {model.asking === "failed" && (
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
                  disabled={model.asking === "asking"}
                  onClick={model.stopDownload}
                >
                  {t("ai.stopDownload")}
                </Button>
              )}
            </AiDetails>
          )}
          {state._tag === "ready" && children}
        </>
      )}
      {setup}
    </li>
  );
}

/**
 * Every AI account, one row each (`AiAccountRow`): the operator signs in to
 * the one they have, right where it says it is not connected. `extra` is
 * what each row shows once connected, as its version in Settings.
 */
export function AiAccountList({
  ai,
  paths = false,
  stale = false,
  extra,
}: {
  ai: WebAiConnect;
  paths?: boolean;
  stale?: boolean;
  extra?: (account: AiAccount) => ReactNode;
}) {
  const { t } = useI18n();
  return (
    <ul aria-label={t("ai.choice.label")} className="flex w-full flex-col gap-2">
      {aiAccounts.map((account) => (
        <AiAccountRow
          key={account}
          ai={ai}
          model={ai.accounts[account]}
          paths={paths}
          stale={stale}
        >
          {extra?.(account)}
        </AiAccountRow>
      ))}
    </ul>
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

/**
 * Connecting an AI in one place, for a screen that is not Settings: the
 * accounts, one row each, that it uses the plan the operator already has,
 * and the endpoint folded away. The first run's step and a conversation
 * whose bot waits for its AI.
 */
export function AiConnect({ ai }: { ai: WebAiConnect }) {
  const { t } = useI18n();
  return (
    <div className="flex w-full flex-col items-center gap-3">
      <AiAccountList ai={ai} />
      <p className="text-center text-xs text-pretty text-muted-foreground">{t("ai.plan")}</p>
      <AdvancedEndpoint ai={ai} />
    </div>
  );
}
