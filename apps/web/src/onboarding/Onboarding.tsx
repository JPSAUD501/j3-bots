// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  defaultBotName,
  makingProgress,
  nextStep,
  type OnboardingFlow,
  type OnboardingStep,
  previousStep,
  providerGate,
  showsConnect,
  showsVault,
} from "@j3-bots/client-runtime/presentation";
import { avatarCast, springs } from "@j3-bots/design-tokens";
import { type IntentResult, refusedWith } from "@j3-bots/client-runtime";
import { connectStepText, providerLine } from "@j3-bots/client-runtime/wording";
import type { AvatarChoice, BotId, EngineStatus } from "@j3-bots/contracts";
import { ChevronLeftIcon } from "lucide-react";
import {
  type CSSProperties,
  type ReactNode,
  type Ref,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { useI18n, usePresentation } from "../app/context";
import { AvatarChoices } from "../components/avatar/AvatarPicker";
import { type AvatarHandle, BotAvatar } from "../components/avatar/BotAvatar";
import { CommandLine } from "../components/CommandLine";
import { type LocalProviderSetup, LocalSignIn } from "../components/ProviderSetup";
import { Button } from "../components/ui/button";
import { SetupVaultForm, type VaultAccess } from "../components/vault/VaultForms";
import { cn } from "../lib/cn";
import { Cast } from "./Cast";
import { BigButton, bigFieldClass, StepTitle } from "./parts";
import { springAnimation, useReducedMotion } from "./motion";

/** How long the arrival stays at least, so the bot is seen arriving before its conversation opens. */
const ARRIVAL_MS = 1600;

const after = (ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms));

/** How far a step slides as it comes and goes, in px. */
const SLIDE = 48;

interface OnboardingProps {
  /** Null until the server has reported it. */
  readonly engine: EngineStatus | null;
  /** Creates the first bot, resolving with its id once it exists, or with why it does not. */
  readonly onCreate: (bot: {
    readonly name: string;
    readonly avatar: AvatarChoice;
  }) => Promise<IntentResult<BotId>>;
  /** Opens the new bot's conversation, which ends the first run. */
  readonly onArrived: (botId: BotId) => void;
  /** Where it starts: the welcome, or another step for the gallery. */
  readonly initialStep?: OnboardingStep;
  /** The first bot's name until the operator changes it; a random one by default. */
  readonly initialName?: string;
  /** Under the welcome's action: the ways out before there is a roster, such as signing out. */
  readonly footer?: ReactNode;
  /**
   * Signing the providers in from this app, while its server runs on this
   * computer; without it, the connect step gives the command to run there.
   */
  readonly providerSetup?: LocalProviderSetup;
  /**
   * What the bot's arrival waits for before the server has it, said under the
   * bot, as while the server on this computer starts; `null` for nothing.
   */
  readonly waiting?: string | null;
  /** The server's vault: while it has no password, a step offers to set one. */
  readonly vault?: VaultAccess;
}

type Direction = "forward" | "back";

/** Why the bot was not created: the server has no model for it, or anything else. */
type Failure = "no-model" | "other";

/**
 * The first run, from the welcome to the first bot's arrival, one thing per
 * screen. Each screen slides in from the side it comes from, and Back always
 * returns to the one before. The bot being made stays in place above the
 * screens and answers what the operator does. Continue always works: the
 * name and the look have defaults, and a provider that is not connected yet
 * never holds the bot back, which then says hello once one is.
 */
export function Onboarding({
  engine,
  onCreate,
  onArrived,
  initialStep = "welcome",
  initialName,
  footer,
  providerSetup,
  waiting = null,
  vault,
}: OnboardingProps) {
  const i18n = useI18n();
  const { t } = i18n;
  const reduced = useReducedMotion();
  const [fallbackName] = useState(
    () => initialName ?? defaultBotName(crypto.getRandomValues(new Uint32Array(1))[0] ?? 0),
  );
  const [name, setName] = useState(fallbackName);
  const [look, setLook] = useState<AvatarChoice>(avatarCast[0]);
  const [view, setView] = useState<{
    readonly step: OnboardingStep;
    readonly direction: Direction;
    /** The step going away, while it does. */
    /** The screen going away, a new one at each move, so its exit restarts even for the same step. */
    readonly leaving: { readonly step: OnboardingStep } | null;
    /** Counts moves, so each one's layers are new. */
    readonly move: number;
  }>({ step: initialStep, direction: "forward", leaving: null, move: 0 });
  const [failure, setFailure] = useState<Failure | null>(null);
  // Whether the connect step was shown: from then on it stays in the flow (`showsConnect`).
  const [connectShown, setConnectShown] = useState(initialStep === "connect");
  // Likewise for the vault's step, which setting the password there must not take away.
  const [vaultShown, setVaultShown] = useState(initialStep === "vault");
  // Whether the bot exists: the arrival names it only then.
  const [created, setCreated] = useState(initialStep === "arrival");
  // Counts what the operator does to the bot, so it answers each with a hop.
  const [pokes, setPokes] = useState(0);
  const { step } = view;
  const botName = name.trim() === "" ? fallbackName : name.trim();
  const flow: OnboardingFlow = {
    connect: showsConnect(engine, connectShown),
    vault: vault !== undefined && showsVault(vault.view, vaultShown),
  };

  const go = (to: OnboardingStep, direction: Direction) => {
    if (to === "connect") setConnectShown(true);
    if (to === "vault") setVaultShown(true);
    setView((now) => ({
      step: to,
      direction,
      leaving: reduced ? null : { step: now.step },
      move: now.move + 1,
    }));
    if (to !== "welcome") setPokes((count) => count + 1);
  };
  // Each new step takes focus at its title, so a screen reader starts there; the name step
  // puts it in its field itself. The first step leaves focus where the page put it.
  const currentRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (view.move === 0 || currentRef.current === null) return;
    if (currentRef.current.contains(document.activeElement)) return;
    currentRef.current
      .querySelector<HTMLElement>("[data-step-title]")
      ?.focus({ preventScroll: true });
  }, [view.move]);
  useEffect(() => {
    if (view.leaving === null) return;
    const done = window.setTimeout(
      () => setView((now) => ({ ...now, leaving: null })),
      springs.slide.duration,
    );
    return () => window.clearTimeout(done);
  }, [view.leaving]);

  const forward = () => {
    const to = nextStep(step, flow);
    if (to === null) return;
    if (to === "arrival") {
      create();
      return;
    }
    go(to, "forward");
  };
  const back = () => {
    const to = previousStep(step, flow);
    if (to !== null) go(to, "back");
  };

  const create = () => {
    setFailure(null);
    const from = step;
    go("arrival", "forward");
    const failed = (why: Failure) => {
      setFailure(why);
      go(from, "back");
    };
    onCreate({ name: botName, avatar: look }).then(
      (result) => {
        if (result._tag === "failed") {
          failed(refusedWith(result, "model") ? "no-model" : "other");
          return;
        }
        // The bot exists: it is seen arriving before its conversation opens.
        setCreated(true);
        void after(reduced ? 0 : ARRIVAL_MS).then(() => onArrived(result.value));
      },
      () => failed("other"),
    );
  };

  const progress = makingProgress(step, flow);
  const canGoBack = previousStep(step, flow) !== null;
  const style: CSSProperties & Record<"--onboarding-bot", string> = {
    "--onboarding-bot": `var(--bot-${look.color})`,
  };

  const screen = (at: OnboardingStep, current: boolean): ReactNode => {
    switch (at) {
      case "welcome":
        return <Welcome onStart={forward} footer={footer} />;
      case "name":
        return (
          <NameStep
            name={name}
            fallback={fallbackName}
            onName={(typed) => {
              setName(typed);
              setPokes((count) => count + 1);
            }}
            onContinue={forward}
            current={current}
          />
        );
      case "look":
        return (
          <LookStep
            name={botName}
            look={look}
            onLook={(next) => {
              setLook(next);
              setPokes((count) => count + 1);
            }}
            ready={nextStep("look", flow) === "arrival"}
            failure={failure}
            onContinue={forward}
          />
        );
      case "vault":
        return vault === undefined ? null : (
          <VaultStep
            vault={vault}
            name={botName}
            creates={nextStep("vault", flow) === "arrival"}
            failure={failure}
            onContinue={forward}
          />
        );
      case "connect":
        return (
          <ConnectStep
            engine={engine}
            name={botName}
            failure={failure}
            onCreate={create}
            providerSetup={providerSetup}
          />
        );
      case "arrival":
        return <Arrival engine={engine} name={botName} created={created} waiting={waiting} />;
    }
  };

  return (
    <div
      className="onboarding @container relative flex h-full min-h-0 flex-1 flex-col overflow-hidden"
      style={style}
    >
      <div className="relative mx-auto flex min-h-0 w-full max-w-md flex-1 flex-col @3xl:my-auto @3xl:max-h-180">
        <header className="flex h-14 shrink-0 items-center px-3">
          <span className="w-10">
            {canGoBack && (
              <Button
                variant="ghost-muted"
                size="icon"
                aria-label={t("onboarding.back")}
                onClick={back}
              >
                <ChevronLeftIcon className="size-5 rtl:-scale-x-100" />
              </Button>
            )}
          </span>
          <span className="flex flex-1 justify-center">
            {progress !== null && <Progress {...progress} />}
          </span>
          <span className="w-10" />
        </header>
        {step !== "welcome" && (
          <Hero look={look} pokes={pokes} arrived={step === "arrival" && created} />
        )}
        <div className="relative min-h-0 flex-1">
          {view.leaving !== null && (
            <Layer key={`out:${view.move}`} motion={`out-${view.direction}`}>
              {screen(view.leaving.step, false)}
            </Layer>
          )}
          <Layer
            key={`in:${view.move}`}
            ref={currentRef}
            motion={view.move === 0 ? null : `in-${view.direction}`}
          >
            {screen(step, true)}
          </Layer>
        </div>
      </div>
    </div>
  );
}

/** One screen of the first run; the one going away is hidden from everything but the eye. */
function Layer({
  motion,
  children,
  ref,
}: {
  readonly motion: `${"in" | "out"}-${Direction}` | null;
  readonly children: ReactNode;
  readonly ref?: Ref<HTMLDivElement>;
}) {
  const leaving = motion?.startsWith("out") === true;
  const sign = motion?.endsWith("back") === true ? -1 : 1;
  const style: CSSProperties =
    motion === null
      ? {}
      : leaving
        ? {
            animation: "onboarding-out calc(var(--duration-slide) / 2) var(--ease-out) both",
            ["--onboarding-shift" as string]: `${-sign * SLIDE}px`,
          }
        : {
            animation: springAnimation("onboarding-in"),
            ["--onboarding-shift" as string]: `${sign * SLIDE}px`,
          };
  return (
    <div
      ref={ref}
      className={cn("absolute inset-0 flex flex-col", leaving && "pointer-events-none")}
      style={style}
      {...(leaving ? { "aria-hidden": true, inert: true } : {})}
    >
      {children}
    </div>
  );
}

/** Where the bot is among the steps that make it: one dot each, the current one long. */
function Progress({ index, count }: { readonly index: number; readonly count: number }) {
  const { t } = useI18n();
  return (
    <span
      role="img"
      aria-label={t("onboarding.progress", { current: index + 1, count })}
      className="flex items-center gap-1.5"
    >
      {Array.from({ length: count }, (_, dot) => (
        <span
          key={dot}
          className={cn(
            "h-1.5 rounded-full bg-foreground transition-[width,opacity] duration-(--duration-soft) ease-soft",
            dot === index ? "w-5" : "w-1.5 opacity-25",
          )}
        />
      ))}
    </span>
  );
}

/**
 * The bot being made, above the screens: it pops in, hops at every step and
 * every change, morphs into a new shape, and grows when it arrives, with rings
 * in its colour.
 */
function Hero({
  look,
  pokes,
  arrived,
}: {
  readonly look: AvatarChoice;
  readonly pokes: number;
  readonly arrived: boolean;
}) {
  const bot = useRef<AvatarHandle>(null);
  const shape = useRef(look.shape);
  useEffect(() => {
    if (look.shape !== shape.current) bot.current?.poke("morph");
    shape.current = look.shape;
  }, [look.shape]);
  return (
    <div
      aria-hidden
      className="relative flex shrink-0 justify-center pt-4 pb-6 [--avatar-cutout:var(--background)]"
    >
      <span
        className="relative block transition-transform duration-(--duration-pop) ease-pop"
        style={{ transform: arrived ? "translateY(56px) scale(1.5)" : "none" }}
      >
        {arrived && (
          <span className="absolute inset-0" style={{ color: "var(--onboarding-bot)" }}>
            {[0, 1, 2].map((ring) => (
              <span
                key={ring}
                className="absolute inset-0 rounded-full border-2 border-current"
                style={{
                  animation: `onboarding-ring 1400ms var(--ease-out) calc(var(--duration-pop) / 2 + ${ring * 220}ms) both`,
                }}
              />
            ))}
          </span>
        )}
        <span className="pop-in block">
          <span
            key={pokes}
            className="block"
            style={{ animation: springAnimation("onboarding-hop", "pop") }}
          >
            <BotAvatar ref={bot} avatar={look} seed="first-bot" state="idle" size={96} />
          </span>
        </span>
      </span>
    </div>
  );
}

/** The content of a step, then its actions at the bottom; side by side with the window on wide screens. */
function StepFrame({
  children,
  actions,
}: {
  readonly children: ReactNode;
  readonly actions: ReactNode;
}) {
  return (
    <div className="flex h-full min-h-0 flex-col pb-[max(--spacing(6),env(safe-area-inset-bottom))]">
      {/* The side room is inside the scrolling column, so a focus ring at its edge is not cut off. */}
      <div className="flex min-h-0 flex-1 flex-col items-center gap-3 overflow-y-auto px-6 text-center">
        {children}
      </div>
      <div className="flex shrink-0 flex-col gap-3 px-6 pt-4">{actions}</div>
    </div>
  );
}

function Welcome({
  onStart,
  footer,
}: {
  readonly onStart: () => void;
  readonly footer: ReactNode;
}) {
  const { t } = useI18n();
  return (
    <StepFrame
      actions={
        <>
          <BigButton onClick={onStart}>{t("onboarding.welcome.start")}</BigButton>
          {footer}
        </>
      }
    >
      <div className="flex flex-1 flex-col items-center justify-center gap-6">
        <Cast />
        <div className="flex flex-col gap-3">
          <StepTitle>
            <span className="display-type text-4xl">J3 Bots</span>
          </StepTitle>
          <p className="max-w-xs text-lg text-pretty text-muted-foreground">
            {t("onboarding.welcome.body")}
          </p>
        </div>
      </div>
    </StepFrame>
  );
}

function NameStep({
  name,
  fallback,
  onName,
  onContinue,
  current,
}: {
  readonly name: string;
  readonly fallback: string;
  readonly onName: (name: string) => void;
  readonly onContinue: () => void;
  readonly current: boolean;
}) {
  const { t } = useI18n();
  const inputId = useId();
  const hintId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  // A mouse or keyboard goes straight to the name; a touch screen would raise its keyboard over the step.
  useLayoutEffect(() => {
    if (!current || window.matchMedia("(pointer: coarse)").matches) return;
    inputRef.current?.focus({ preventScroll: true });
    inputRef.current?.select();
  }, [current]);
  return (
    <form
      className="contents"
      onSubmit={(event) => {
        event.preventDefault();
        onContinue();
      }}
    >
      <StepFrame actions={<BigButton type="submit">{t("onboarding.continue")}</BigButton>}>
        <StepTitle>{t("onboarding.name.title")}</StepTitle>
        <label htmlFor={inputId} className="sr-only">
          {t("onboarding.name.label")}
        </label>
        <input
          ref={inputRef}
          id={inputId}
          value={name}
          maxLength={40}
          autoComplete="off"
          spellCheck={false}
          placeholder={fallback}
          aria-describedby={hintId}
          onChange={(event) => onName(event.currentTarget.value)}
          className={cn(
            bigFieldClass,
            "mt-2 h-14 text-center display-type text-3xl pointer-coarse:h-14 focus-visible:outline-(color:--onboarding-bot)",
          )}
        />
        <p id={hintId} className="text-sm text-muted-foreground">
          {t("onboarding.name.hint")}
        </p>
      </StepFrame>
    </form>
  );
}

function LookStep({
  name,
  look,
  onLook,
  ready,
  failure,
  onContinue,
}: {
  readonly name: string;
  readonly look: AvatarChoice;
  readonly onLook: (look: AvatarChoice) => void;
  /** Whether the next step is the arrival, so Continue creates the bot. */
  readonly ready: boolean;
  readonly failure: Failure | null;
  readonly onContinue: () => void;
}) {
  const { t } = useI18n();
  return (
    <StepFrame
      actions={
        <>
          {ready && <FailureLine failure={failure} name={name} />}
          <BigButton onClick={onContinue}>
            {ready ? t("onboarding.create", { name }) : t("onboarding.continue")}
          </BigButton>
        </>
      }
    >
      <StepTitle>{t("onboarding.look.title", { name })}</StepTitle>
      <AvatarChoices value={look} onChange={onLook} className="mt-2 w-full max-w-80 text-start" />
      <p className="text-sm text-muted-foreground">{t("onboarding.look.hint")}</p>
    </StepFrame>
  );
}

/** Why the bot was not created, in a space held for it: empty, it takes none. */
function FailureLine({
  failure,
  name,
}: {
  readonly failure: Failure | null;
  readonly name: string;
}) {
  const { t } = useI18n();
  return (
    <p role="alert" className="text-center text-sm text-blocked empty:hidden">
      {failure === null
        ? null
        : t(failure === "no-model" ? "onboarding.failedNoModel" : "onboarding.failed", { name })}
    </p>
  );
}

const toneClass = {
  waiting: "text-waiting",
  ready: "text-success",
  muted: "text-muted-foreground",
} as const;

function ConnectStep({
  engine,
  name,
  failure,
  onCreate,
  providerSetup,
}: {
  readonly engine: EngineStatus | null;
  readonly name: string;
  readonly failure: Failure | null;
  readonly onCreate: () => void;
  readonly providerSetup: LocalProviderSetup | undefined;
}) {
  const i18n = useI18n();
  const ctx = usePresentation();
  const { t } = i18n;
  const text = connectStepText(engine, name, i18n);
  const gate = engine !== null && engine.state._tag === "ready" ? providerGate(engine) : null;
  const unavailable = gate?._tag === "unavailable";
  // On this computer, the harnesses sign in from here; the command stays for when they cannot.
  const signInHere = gate?._tag === "connect" ? providerSetup : undefined;
  const command = (
    <>
      {text.command !== null && (
        <div className="mt-1 w-full text-start">
          <CommandLine command={text.command} copyLabel={t("firstRun.connect.copy")} large />
        </div>
      )}
      {text.login !== null && (
        <p className="text-sm text-pretty text-muted-foreground">
          {text.login.text}{" "}
          <a
            href={text.login.url}
            target="_blank"
            rel="noreferrer"
            className="font-medium text-foreground underline underline-offset-2"
          >
            {text.login.link}
          </a>
        </p>
      )}
    </>
  );
  return (
    <StepFrame
      actions={
        <>
          <FailureLine failure={failure} name={name} />
          <BigButton onClick={onCreate}>{t("onboarding.create", { name })}</BigButton>
          {text.later !== null && (
            <p className="text-center text-sm text-pretty text-muted-foreground">{text.later}</p>
          )}
        </>
      }
    >
      <StepTitle>{text.title}</StepTitle>
      <p className="text-lg text-pretty text-muted-foreground">
        {signInHere !== undefined ? t("onboarding.connect.local.body") : text.body}
      </p>
      {signInHere !== undefined ? <LocalSignIn setup={signInHere} fallback={command} /> : command}
      {unavailable && engine !== null && (
        <ul className="flex w-full flex-col gap-1 text-sm">
          {engine.providers.map((provider) => {
            const line = providerLine(provider, ctx);
            return (
              <li key={provider.id} className="flex justify-between gap-3">
                <span>{provider.name}</span>
                <span className="text-muted-foreground">{line.text}</span>
              </li>
            );
          })}
        </ul>
      )}
      {/* Live: the step says when a provider connects, without moving on by itself. */}
      <p
        role="status"
        className={cn("flex items-center gap-2 text-sm font-medium", toneClass[text.status.tone])}
      >
        <span
          aria-hidden
          className={cn(
            "size-2 rounded-full bg-current",
            text.status.tone === "waiting" && "onboarding-pulse",
          )}
        />
        {text.status.text}
      </p>
    </StepFrame>
  );
}

/**
 * The vault's master password, which the operator may set now or skip: a
 * password set here stays set, and the step only moves on. Once it is set,
 * Back and forth through it shows that, and Continue.
 */
function VaultStep({
  vault,
  name,
  creates,
  failure,
  onContinue,
}: {
  readonly vault: VaultAccess;
  readonly name: string;
  /** Whether the next step is the arrival, so moving on creates the bot. */
  readonly creates: boolean;
  readonly failure: Failure | null;
  readonly onContinue: () => void;
}) {
  const { t } = useI18n();
  const set = vault.view._tag === "ready" && vault.view.status.state !== "uninitialized";
  const next = creates ? t("onboarding.create", { name }) : t("onboarding.continue");
  return (
    <StepFrame
      actions={
        <>
          {creates && <FailureLine failure={failure} name={name} />}
          {set && <BigButton onClick={onContinue}>{next}</BigButton>}
        </>
      }
    >
      <StepTitle>{t("onboarding.vault.title")}</StepTitle>
      <p className="text-lg text-pretty text-muted-foreground">{t("onboarding.vault.body")}</p>
      {set ? (
        <p role="status" className="flex items-center gap-2 text-sm font-medium text-success">
          <span aria-hidden className="size-2 rounded-full bg-current" />
          {t("onboarding.vault.done")}
        </p>
      ) : (
        <SetupVaultForm
          intents={vault.intents}
          onDone={onContinue}
          className="w-full"
          actions={
            <Button variant="ghost-muted" size="sm" onClick={onContinue}>
              {t("onboarding.vault.skip")}
            </Button>
          }
        />
      )}
    </StepFrame>
  );
}

/**
 * The bot arriving. Until the server has created it, only the bot above says
 * something is happening, and a line what it waits for, if anything; then it
 * grows, its name pops in, and a line says whether it is saying hello or
 * waits for a model.
 */
function Arrival({
  engine,
  name,
  created,
  waiting,
}: {
  readonly engine: EngineStatus | null;
  readonly name: string;
  readonly created: boolean;
  readonly waiting: string | null;
}) {
  const { t } = useI18n();
  const ready =
    engine !== null && engine.state._tag === "ready" && providerGate(engine)._tag === "ready";
  return (
    <StepFrame actions={null}>
      <div className="mt-24 flex flex-col items-center gap-2">
        {created && (
          <h1
            className="display-type text-4xl"
            style={{ animation: springAnimation("pop-in", "pop", 260) }}
          >
            {t("onboarding.arrival.title", { name })}
          </h1>
        )}
        {/* Present from the start, so what it says once the bot exists is announced. */}
        <p role="status" className="text-lg text-muted-foreground">
          {created && (
            <span
              className="block"
              style={{ animation: springAnimation("onboarding-rise", "soft", 420) }}
            >
              {ready ? t("onboarding.arrival.hello") : t("onboarding.arrival.waiting", { name })}
            </span>
          )}
          {!created && waiting !== null && <span className="block arrive">{waiting}</span>}
        </p>
      </div>
    </StepFrame>
  );
}
