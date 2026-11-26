// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  cannotRun,
  defaultBotName,
  makingProgress,
  nextStep,
  type OnboardingFlow,
  type OnboardingStep,
  previousStep,
  providerGate,
  resumedStep,
  showsConnect,
  stageScene,
} from "@j3-bots/client-runtime/presentation";
import { avatarCast, stage } from "@j3-bots/design-tokens";
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
import { CommandLine } from "../components/CommandLine";
import { type ProviderActions, ProviderFix } from "../components/ProviderFix";
import { engineFindings, type LocalProviderSetup, LocalSignIn } from "../components/ProviderSetup";
import { Button } from "../components/ui/button";
import { cn } from "../lib/cn";
import { openArrived } from "./handoff";
import { useReducedMotion } from "./motion";
import { BigButton, bigFieldClass, StepTitle } from "./parts";
import { clearProgress, readProgress, writeProgress } from "./progress";
import { Stage, type StageHandle } from "./Stage";

const after = (ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms));

/**
 * Where the arrival's title starts under the stage, below the farthest ring,
 * so no ring crosses it: how far the ring reaches under the grown bot's feet.
 */
const ARRIVAL_TITLE_TOP = Math.round(
  (96 * (1 + stage.arrivalGrowth) * (stage.rings.reach - 1)) / 2 - 20,
);

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
  /** What the connect step's lines ask of the server: check a provider again, install its harness. */
  readonly providerActions: ProviderActions;
  /**
   * Where it starts, for the gallery: that step, with nothing remembered.
   * Without it the first run starts at the welcome, or where this browser
   * left it.
   */
  readonly initialStep?: OnboardingStep;
  /** The first bot's name until the operator changes it; a random one by default. */
  readonly initialName?: string;
  /** Under the welcome's action: the ways out before there is a roster, such as signing out. */
  readonly footer?: ReactNode;
  /**
   * Signing the providers in from this app, while its server runs on this
   * computer; `undefined` elsewhere, where the connect step gives the command
   * to run on the server. Every first run says which it is.
   */
  readonly providerSetup: LocalProviderSetup | undefined;
  /**
   * What the bot's arrival waits for before the server has it, said under the
   * bot, as while the server on this computer starts; `null` for nothing.
   */
  readonly waiting?: string | null;
}

/** Why the bot was not created: the server has no model for it, or anything else. */
type Failure = "no-model" | "other";

/**
 * The first run, from the welcome to the first bot's arrival, played on a
 * stage (`Stage`): the cast comes down into its lights, the camera closes in
 * on the bot being made, and each step's words arrive under it, out of focus
 * first. The bot answers what the operator does: it looks down at the name as
 * it is typed and wears it, takes each shape and color as it is picked, and
 * when it exists the lights come up, everyone cheers, and it travels on into
 * its conversation.
 *
 * It is a short the operator plays, never one they wait for. Every action is
 * live from the first frame, so pressing on cuts to the next scene from
 * wherever this one is; Back always returns to the one before; Continue always
 * works, since the name and the look have defaults and a provider that is not
 * connected yet never holds the bot back, which then says hello once one is.
 * Left mid-way, it starts again where it was (`progress.ts`).
 */
export function Onboarding({
  engine,
  onCreate,
  onArrived,
  providerActions,
  initialStep,
  initialName,
  footer,
  providerSetup,
  waiting = null,
}: OnboardingProps) {
  const i18n = useI18n();
  const { t } = i18n;
  const reduced = useReducedMotion();
  const [seed] = useState(() => crypto.getRandomValues(new Uint32Array(1))[0] ?? 0);
  // What this browser left the first run at; a step given, as the gallery gives, starts fresh there.
  const [saved] = useState(() => (initialStep === undefined ? readProgress() : null));
  const remembers = initialStep === undefined;
  // In the language the operator reads now, until they type one of their own.
  const fallbackName = initialName ?? defaultBotName(i18n.locale, seed);
  const [typed, setTyped] = useState<string | null>(saved?.name ?? null);
  const name = typed ?? fallbackName;
  const [look, setLook] = useState<AvatarChoice>(saved?.look ?? avatarCast[0]);
  // Whether the connect step was shown: from then on it stays in the flow (`showsConnect`).
  const [connectShown, setConnectShown] = useState(initialStep === "connect");
  const flow: OnboardingFlow = {
    connect: showsConnect(engine, connectShown),
  };
  const [view, setView] = useState<{
    readonly step: OnboardingStep;
    /** The screen going away, while it does: a new one at each move, so its exit restarts even for the same step. */
    readonly leaving: { readonly step: OnboardingStep } | null;
    /** Counts moves, so each one's layers are new. */
    readonly move: number;
  }>(() => ({
    step: initialStep ?? (saved === null ? "welcome" : resumedStep(saved.step, flow)),
    leaving: null,
    move: 0,
  }));
  const [failure, setFailure] = useState<Failure | null>(null);
  // Whether the bot exists: the arrival names it only then.
  const [created, setCreated] = useState(initialStep === "arrival");
  const { step } = view;
  const botName = name.trim() === "" ? fallbackName : name.trim();
  const cast = useRef<StageHandle>(null);

  // Kept as it goes, so leaving the first run does not start it over.
  useEffect(() => {
    if (remembers && !created) writeProgress({ step, name: typed, look });
  }, [remembers, created, step, typed, look]);

  const go = (to: OnboardingStep) => {
    if (to === "connect") setConnectShown(true);
    setView((now) => ({ step: to, leaving: { step: now.step }, move: now.move + 1 }));
    // The bot being made takes each step with the operator.
    if (to !== "welcome") cast.current?.lead(to === "arrival" ? "hover" : "nod");
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
      stage.leave,
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
    go(to);
  };
  const back = () => {
    const to = previousStep(step, flow);
    if (to !== null) go(to);
  };

  const create = () => {
    setFailure(null);
    const from = step;
    go("arrival");
    const failed = (why: Failure) => {
      setFailure(why);
      go(from);
    };
    onCreate({ name: botName, avatar: look }).then(
      (result) => {
        if (result._tag === "failed") {
          failed(refusedWith(result, "model") ? "no-model" : "other");
          return;
        }
        // The bot exists: it is seen arriving before its conversation opens.
        if (remembers) clearProgress();
        setCreated(true);
        void after(reduced ? 0 : stage.hold).then(() =>
          openArrived(result.value, () => onArrived(result.value), !reduced),
        );
      },
      () => failed("other"),
    );
  };

  const progress = makingProgress(step, flow);
  const canGoBack = previousStep(step, flow) !== null;
  const arrived = step === "arrival" && created;
  const style: CSSProperties & Record<`--stage-${string}` | "--onboarding-bot", string> = {
    "--onboarding-bot": `var(--bot-${look.color})`,
    "--stage-spot-in": `${stage.spotIn}ms`,
    "--stage-blur": `${stage.focus.blur}px`,
    "--stage-rise": `${stage.focus.rise}px`,
    "--stage-gap": `${stage.focus.gap}ms`,
    "--stage-leave": `${stage.leave}ms`,
    "--stage-sweep": `${stage.sweep}ms`,
    "--stage-grown": String(1 + stage.arrivalGrowth),
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
            onName={(next) => {
              setTyped(next);
              cast.current?.lead("type");
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
              // A new shape is taken in a squash; a new color is good news.
              cast.current?.lead(next.shape === look.shape ? "hop" : "morph");
              setLook(next);
            }}
            ready={nextStep("look", flow) === "arrival"}
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
            providerActions={providerActions}
            providerSetup={providerSetup}
          />
        );
      case "arrival":
        return <Arrival engine={engine} name={botName} created={created} waiting={waiting} />;
    }
  };

  return (
    <div
      className="onboarding dark @container relative flex h-full min-h-0 flex-1 flex-col overflow-hidden bg-background text-foreground"
      style={style}
    >
      <div className="relative mx-auto flex min-h-0 w-full max-w-md flex-1 flex-col @3xl:my-auto @3xl:max-h-180">
        <header className="relative z-10 flex h-14 shrink-0 items-center px-3">
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
        <Stage
          ref={cast}
          scene={stageScene(step, created)}
          look={look}
          name={botName}
          arrived={arrived}
        />
        <div className="relative min-h-0 flex-1">
          {view.leaving !== null && (
            <Layer key={`out:${view.move}`} motion="out" reduced={reduced}>
              {screen(view.leaving.step, false)}
            </Layer>
          )}
          <Layer key={`in:${view.move}`} ref={currentRef} motion="in" reduced={reduced}>
            {screen(step, true)}
          </Layer>
        </div>
      </div>
      {arrived && !reduced && <span aria-hidden className="stage-sweep" />}
    </div>
  );
}

/**
 * One step's words and controls, under the stage; the one going away is
 * hidden from everything but the eye. A step's lines arrive one after another,
 * out of focus first (`focus-pull` in the stylesheet), as the step before
 * fades; under reduced motion the two only crossfade.
 */
function Layer({
  motion,
  reduced,
  children,
  ref,
}: {
  readonly motion: "in" | "out";
  readonly reduced: boolean;
  readonly children: ReactNode;
  readonly ref?: Ref<HTMLDivElement>;
}) {
  const leaving = motion === "out";
  return (
    <div
      ref={ref}
      className={cn(
        "absolute inset-0 flex flex-col",
        leaving && "pointer-events-none",
        reduced
          ? cn("crossfade", leaving ? "onboarding-fade-out" : "onboarding-fade-in")
          : leaving
            ? "stage-leaves"
            : "focus-pull",
      )}
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
      <div className="focus-lines flex min-h-0 flex-1 flex-col items-center gap-3 overflow-y-auto px-6 pt-1 text-center">
        {children}
      </div>
      <div className="focus-last flex shrink-0 flex-col gap-3 px-6 pt-4">{actions}</div>
    </div>
  );
}

/** The first screen, under the cast as it comes in: what J3 Bots is, and the way in. */
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
        <div className="flex flex-col gap-3">
          <BigButton onClick={onStart}>{t("onboarding.welcome.start")}</BigButton>
          {footer}
        </div>
      }
    >
      <StepTitle>
        <span className="display-type text-4xl">J3 Bots</span>
      </StepTitle>
      <p className="max-w-xs text-lg text-pretty text-muted-foreground">
        {t("onboarding.welcome.body")}
      </p>
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
  providerActions,
  providerSetup,
}: {
  readonly engine: EngineStatus | null;
  readonly name: string;
  readonly failure: Failure | null;
  readonly onCreate: () => void;
  readonly providerActions: ProviderActions;
  readonly providerSetup: LocalProviderSetup | undefined;
}) {
  const i18n = useI18n();
  const ctx = usePresentation();
  const { t } = i18n;
  const text = connectStepText(engine, name, i18n);
  const waitsId = useId();
  const place = providerSetup === undefined ? "server" : "this-computer";
  const gate = engine !== null && engine.state._tag === "ready" ? providerGate(engine) : null;
  // Each provider that cannot run, with why and what fixes it: all of them
  // when none can, and beside the sign-in, those that signing in would not fix.
  const listed =
    engine === null || gate === null
      ? []
      : gate._tag === "unavailable"
        ? engine.providers
        : gate._tag === "connect"
          ? engine.providers.filter(cannotRun)
          : [];
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
          <BigButton
            onClick={onCreate}
            disabled={text.createWaits !== null}
            describedBy={text.createWaits === null ? undefined : waitsId}
          >
            {t("onboarding.create", { name })}
          </BigButton>
          {(text.createWaits ?? text.later) !== null && (
            <p id={waitsId} className="text-center text-sm text-pretty text-muted-foreground">
              {text.createWaits ?? text.later}
            </p>
          )}
        </>
      }
    >
      <StepTitle>{text.title}</StepTitle>
      <p className="text-lg text-pretty text-muted-foreground">
        {signInHere !== undefined ? t("onboarding.connect.local.body") : text.body}
      </p>
      {signInHere !== undefined ? (
        <LocalSignIn setup={signInHere} fallback={command} findings={engineFindings(engine)} />
      ) : (
        command
      )}
      {listed.length > 0 && (
        <ul className="flex w-full flex-col gap-3 text-start text-sm">
          {listed.map((provider) => {
            const line = providerLine(provider, ctx, place);
            return (
              <li key={provider.id} className="flex flex-col gap-1.5">
                <div className="flex justify-between gap-3">
                  <span>{provider.name}</span>
                  <span className="text-muted-foreground">{line.text}</span>
                </div>
                {provider.status._tag === "unavailable" && provider.status.detail !== undefined && (
                  <p className="text-xs break-words text-pretty text-muted-foreground">
                    {t("provider.detail", { detail: provider.status.detail })}
                  </p>
                )}
                <ProviderFix provider={provider} place={place} actions={providerActions} />
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
 * The bot arriving. Until the server has created it, only the bot above, alone
 * in its light, says something is happening, and a line what it waits for, if
 * anything; then the stage plays its finale, the bot's name pops in under it,
 * and a line says whether it is saying hello or waits for a model.
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
      <div className="flex flex-col items-center gap-2" style={{ marginTop: ARRIVAL_TITLE_TOP }}>
        {created && (
          <h1
            className="display-type pop-in text-4xl"
            style={{ animationDelay: `${stage.nameDelay}ms` }}
          >
            {t("onboarding.arrival.title", { name })}
          </h1>
        )}
        {/* Present from the start, so what it says once the bot exists is announced. */}
        <p role="status" className="text-lg text-muted-foreground">
          {created && (
            <span className="arrive block" style={{ animationDelay: `${stage.lineDelay}ms` }}>
              {ready ? t("onboarding.arrival.hello") : t("onboarding.arrival.waiting", { name })}
            </span>
          )}
          {!created && waiting !== null && <span className="block arrive">{waiting}</span>}
        </p>
      </div>
    </StepFrame>
  );
}
