// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  type AiAccount,
  aiOutage,
  connectStepSaysProgress,
  defaultBotName,
  nextStep,
  type OnboardingFlow,
  type OnboardingStep,
  gettingReady,
  readyingShare,
  previousStep,
  providerGate,
  resumedStep,
  showsConnect,
  stageScene,
  stepProgress,
  tellsStory,
  workExamples,
  workTurn,
} from "@j3-bots/client-runtime/presentation";
import { avatarCast, stage } from "@j3-bots/design-tokens";
import { type IntentResult, refusedWith, type ServerUpdateView } from "@j3-bots/client-runtime";
import { AiSessionProvider, useAiOpened } from "@j3-bots/client-runtime/react";
import { aiActionLabel, connectStepText } from "@j3-bots/client-runtime/wording";
import type { AvatarChoice, BotId, EngineStatus } from "@j3-bots/contracts";
import { CheckIcon, ChevronLeftIcon } from "lucide-react";
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
import { useI18n } from "../app/context";
import {
  AdvancedEndpoint,
  AiAccountPanel,
  AiChoice,
  AiDetails,
  connectPlaceOf,
  OtherAccount,
  useAiText,
  useWebAiConnect,
} from "../components/AiConnect";
import { AvatarChoices } from "../components/avatar/AvatarPicker";
import type { ProviderActions } from "../components/ProviderFix";
import type { LocalProviderSetup } from "../components/ProviderSetup";
import { Button } from "../components/ui/button";
import { cn } from "../lib/cn";
import { openArrived } from "./handoff";
import { useReducedMotion } from "./motion";
import { BigButton, bigFieldClass, StepTitle } from "./parts";
import { clearProgress, readProgress, writeProgress } from "./progress";
import { Stage, type StageHandle } from "./Stage";

const after = (ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms));

/** How long "ready" stays once what was being prepared is, in ms, before the line goes. */
const READY_STAYS = 2600;

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
  /** What the connect step asks of the server: check an AI account again, download what it needs. */
  readonly providerActions: ProviderActions;
  /**
   * Where it starts, for the gallery: that step, with nothing remembered.
   * Without it the first run starts at the welcome, or where this browser
   * left it.
   */
  readonly initialStep?: OnboardingStep;
  /** The first bot's name until the operator changes it; a random one by default. */
  readonly initialName?: string;
  /** The AI account the connect step opens on, for the gallery; without it, the step asks which. */
  readonly initialAccount?: AiAccount | undefined;
  /** Under the welcome's action: the ways out before there is a roster, such as signing out. */
  readonly footer?: ReactNode;
  /**
   * Signing the AI accounts in from this app, while its server runs on this
   * computer; `undefined` elsewhere, where the connect step says where they
   * sign in. Every first run says which it is.
   */
  readonly providerSetup: LocalProviderSetup | undefined;
  /**
   * What the server last said of its own updates, which tells a client that
   * reaches the desktop app's server that the accounts sign in in that app;
   * `undefined` where it is not known.
   */
  readonly serverUpdate?: ServerUpdateView | undefined;
  /**
   * Whether the server on this computer is still starting and has not answered
   * yet: the first run goes on meanwhile, says so in its one quiet line, and
   * only the bot's arrival waits for it.
   */
  readonly starting?: boolean;
}

/** Why the bot was not created: the server has no model for it, or anything else. */
type Failure = "no-model" | "other";

/**
 * The first run, from the welcome to the first bot's arrival, played on a
 * stage (`Stage`). It opens by saying what J3 Bots is, in three steps the
 * stage carries: the cast comes down into its lights; the light goes from one
 * bot to the next as each says what it does for the operator; the lights go
 * down and they think, under the one light they share. Then the camera closes
 * in on the bot being made, and each step's words arrive under it, out of
 * focus first. The bot answers what the operator does: it looks down at the
 * name as it is typed and wears it, takes each shape and color as it is
 * picked, and when it exists its light swells, everyone cheers, and it travels
 * on into its conversation.
 *
 * Under every step one quiet line says what the server is still getting ready
 * (`Preparing`), which holds nothing back.
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
  initialAccount,
  footer,
  providerSetup,
  serverUpdate,
  starting = false,
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
  // Where it starts: the step given, the welcome, or the step this browser left it at.
  const [started] = useState<OnboardingStep>(
    () =>
      initialStep ??
      (saved === null
        ? "welcome"
        : resumedStep(saved.step, { connect: showsConnect(engine, false) })),
  );
  // Whether the connect step was shown: from then on it stays in the flow (`showsConnect`).
  // Starting on it counts, so a provider that connects while the operator reads it does not
  // take the step, its dot and the way Back away under them.
  const [connectShown, setConnectShown] = useState(started === "connect");
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
    step: started,
    leaving: null,
    move: 0,
  }));
  const [failure, setFailure] = useState<Failure | null>(null);
  // Whether the bot exists: the arrival names it only then.
  const [created, setCreated] = useState(initialStep === "arrival");
  const { step } = view;
  const botName = name.trim() === "" ? fallbackName : name.trim();
  const cast = useRef<StageHandle>(null);
  // Whose turn in the light it is, while the cast says what it does: it goes once round, a line
  // each, and rests on the last, which is everyone's.
  const [turn, setTurn] = useState(0);
  useEffect(() => {
    if (step !== "work" || reduced || turn >= workExamples.length - 1) return;
    const next = window.setTimeout(() => setTurn(turn + 1), stage.turn);
    return () => window.clearTimeout(next);
  }, [step, reduced, turn]);

  // Kept as it goes, so leaving the first run does not start it over.
  useEffect(() => {
    if (remembers && !created) writeProgress({ step, name: typed, look });
  }, [remembers, created, step, typed, look]);

  const go = (to: OnboardingStep) => {
    if (to === "connect") setConnectShown(true);
    if (to === "work") setTurn(0);
    setView((now) => ({ step: to, leaving: { step: now.step }, move: now.move + 1 }));
    // The bot being made takes each step with the operator.
    if (!tellsStory(to)) cast.current?.lead(to === "arrival" ? "hover" : "nod");
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

  const progress = stepProgress(step, flow);
  const canGoBack = previousStep(step, flow) !== null;
  const arrived = step === "arrival" && created;
  const here = providerSetup !== undefined;
  const style: CSSProperties & Record<`--stage-${string}` | "--onboarding-bot", string> = {
    "--onboarding-bot": `var(--bot-${look.color})`,
    "--stage-blur": `${stage.focus.blur}px`,
    "--stage-rise": `${stage.focus.rise}px`,
    "--stage-gap": `${stage.focus.gap}ms`,
    "--stage-leave": `${stage.leave}ms`,
  };

  const screen = (at: OnboardingStep, current: boolean): ReactNode => {
    switch (at) {
      case "welcome":
        return <Welcome here={here} onContinue={forward} footer={footer} />;
      case "work":
        return <WorkStep turn={turn} reduced={reduced} onContinue={forward} />;
      case "mind":
        return <MindStep onContinue={forward} />;
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
            serverUpdate={serverUpdate}
          />
        );
      case "arrival":
        return (
          <Arrival
            engine={engine}
            name={botName}
            created={created}
            waiting={starting ? t("local.waiting") : null}
          />
        );
    }
  };

  return (
    // One memory of the AI picked for the whole first run: the step and the line under it agree.
    <AiSessionProvider initial={initialAccount}>
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
            featured={step === "work" && !reduced ? workTurn(turn).featured : "all"}
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
          <StepPreparing
            engine={engine}
            starting={starting}
            here={here}
            step={step}
            signIns={providerSetup?.signIns}
          />
        </div>
      </div>
    </AiSessionProvider>
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
    <div className="flex h-full min-h-0 flex-col pb-2">
      {/* The side room is inside the scrolling column, so a focus ring at its edge is not cut off. */}
      <div className="focus-lines flex min-h-0 flex-1 flex-col items-center gap-3 overflow-y-auto px-6 pt-1 text-center">
        {children}
      </div>
      <div className="focus-last flex shrink-0 flex-col gap-3 px-6 pt-4">{actions}</div>
    </div>
  );
}

const noSignIns: LocalProviderSetup["signIns"] = new Map();

/**
 * The quiet line under a step (`Preparing`), silent where the step says the
 * same itself: the arrival, which says what it waits for under the bot, and
 * the connect step while an account is open on it or J3 Bots is out
 * (`connectStepSaysProgress`), so one screen never shows two progress lines.
 */
function StepPreparing({
  engine,
  starting,
  here,
  step,
  signIns = noSignIns,
}: {
  readonly engine: EngineStatus | null;
  readonly starting: boolean;
  readonly here: boolean;
  readonly step: OnboardingStep;
  readonly signIns?: LocalProviderSetup["signIns"] | undefined;
}) {
  const opened = useAiOpened({ engine, locations: null, signIns });
  const quiet =
    step === "arrival" || (step === "connect" && connectStepSaysProgress(engine, opened));
  return <Preparing engine={engine} starting={starting} here={here} quiet={quiet} />;
}

/**
 * What the server is still getting ready, in one quiet line under every step:
 * the engine and the harnesses it downloads, with how far they are when the
 * server says. It holds nothing back, takes its room whether it says anything
 * or not, so nothing moves when it does, and says "ready" once, only after it
 * was seen getting ready. `quiet` keeps it silent, where the step says the
 * same itself.
 */
function Preparing({
  engine,
  starting,
  here,
  quiet,
}: {
  readonly engine: EngineStatus | null;
  readonly starting: boolean;
  /** Whether what is prepared is this computer, or a server elsewhere. */
  readonly here: boolean;
  readonly quiet: boolean;
}) {
  const { t, locale } = useI18n();
  const now = gettingReady(engine, starting);
  const [prepared, setPrepared] = useState<"never" | "under-way" | "said">("never");
  if (now._tag === "preparing" && prepared !== "under-way") setPrepared("under-way");
  const ready = now._tag === "ready" && prepared === "under-way";
  useEffect(() => {
    if (!ready) return;
    const said = window.setTimeout(() => setPrepared("said"), READY_STAYS);
    return () => window.clearTimeout(said);
  }, [ready]);
  const share = readyingShare(now);
  const line =
    quiet || (now._tag !== "preparing" && !ready)
      ? null
      : ready
        ? t(here ? "onboarding.preparedHere" : "onboarding.prepared")
        : t(here ? "onboarding.preparingHere" : "onboarding.preparing");
  return (
    <p
      role="status"
      className="flex h-8 shrink-0 items-center justify-center gap-2 pb-[env(safe-area-inset-bottom)] text-xs text-muted-foreground box-content"
    >
      {line !== null && (
        <span
          key={ready ? "ready" : "preparing"}
          className="onboarding-fade-in inline-flex items-center gap-2"
        >
          {ready ? (
            <CheckIcon aria-hidden className="size-3.5 text-success" />
          ) : (
            <Gauge share={share} />
          )}
          {line}
          {share !== null && (
            <span aria-hidden className="tabular-nums">
              {new Intl.NumberFormat(locale, { style: "percent" }).format(share)}
            </span>
          )}
        </span>
      )}
    </p>
  );
}

const GAUGE_RADIUS = 5.5;
const GAUGE_LENGTH = 2 * Math.PI * GAUGE_RADIUS;

/** A small ring that fills to `share`, from 0 to 1; with none known, an arc of it turns. */
function Gauge({ share }: { readonly share: number | null }) {
  return (
    <svg
      aria-hidden
      viewBox="0 0 14 14"
      className={cn("size-3.5 -rotate-90", share === null && "animate-spin")}
    >
      <circle cx="7" cy="7" r={GAUGE_RADIUS} fill="none" strokeWidth="2" className="stroke-muted" />
      <circle
        cx="7"
        cy="7"
        r={GAUGE_RADIUS}
        fill="none"
        strokeWidth="2"
        strokeLinecap="round"
        strokeDasharray={GAUGE_LENGTH}
        strokeDashoffset={GAUGE_LENGTH * (1 - (share ?? 0.28))}
        className="stroke-current transition-[stroke-dashoffset] duration-(--duration-slow) ease-out"
      />
    </svg>
  );
}

/**
 * The first screen, under the cast as it comes in: what J3 Bots is, in one
 * sentence, said for where the bots live.
 */
function Welcome({
  here,
  onContinue,
  footer,
}: {
  readonly here: boolean;
  readonly onContinue: () => void;
  readonly footer: ReactNode;
}) {
  const { t } = useI18n();
  return (
    <StepFrame
      actions={
        <div className="flex flex-col gap-3">
          <BigButton onClick={onContinue}>{t("onboarding.continue")}</BigButton>
          {footer}
        </div>
      }
    >
      <StepTitle>
        <span className="display-type text-4xl">J3 Bots</span>
      </StepTitle>
      <p className="max-w-xs text-lg text-pretty text-muted-foreground">
        {t(here ? "onboarding.welcome.bodyHere" : "onboarding.welcome.body")}
      </p>
    </StepFrame>
  );
}

/**
 * What the bots do day to day. Each bot says its own line as the light comes
 * to it, one line on screen at a time, and the last is everyone's. A screen
 * reader gets them as one list, and so does reduced motion, with the whole
 * cast lit.
 */
function WorkStep({
  turn,
  reduced,
  onContinue,
}: {
  readonly turn: number;
  readonly reduced: boolean;
  readonly onContinue: () => void;
}) {
  const { t } = useI18n();
  const { example } = workTurn(turn);
  const lines = (className: string) => (
    <ul className={className}>
      {workExamples.map((each) => (
        <li key={each}>{t(`onboarding.work.${each}`)}</li>
      ))}
    </ul>
  );
  return (
    <StepFrame actions={<BigButton onClick={onContinue}>{t("onboarding.continue")}</BigButton>}>
      <StepTitle>{t("onboarding.work.title")}</StepTitle>
      {reduced ? (
        lines("flex flex-col gap-1 text-base text-muted-foreground")
      ) : (
        <>
          <p aria-hidden className="min-h-[2lh] max-w-xs text-xl text-pretty">
            <span key={example} className="stage-line block">
              {t(`onboarding.work.${example}`)}
            </span>
          </p>
          {lines("sr-only")}
        </>
      )}
    </StepFrame>
  );
}

/** What the bots think with, which is what J3 Bots installs: the last of the story, and the way to the first bot. */
function MindStep({ onContinue }: { readonly onContinue: () => void }) {
  const { t } = useI18n();
  return (
    <StepFrame actions={<BigButton onClick={onContinue}>{t("onboarding.meet")}</BigButton>}>
      <StepTitle>{t("onboarding.mind.title")}</StepTitle>
      <p className="max-w-xs text-lg text-pretty text-muted-foreground">
        {t("onboarding.mind.body")}
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

/**
 * The AI the bot thinks with, asked as one question: which one the operator
 * has. Picking one leaves that account alone on the screen, with its sign-in
 * drawn and one big button; the other stays one press away. While something
 * is still asked of the operator, picking an account or pressing its button,
 * that leads, and creating the bot is the quieter way on under it; once
 * nothing is, as while it downloads or once it is connected, the big button
 * creates the bot, which says hello when its AI is ready.
 */
function ConnectStep({
  engine,
  name,
  failure,
  onCreate,
  providerActions,
  providerSetup,
  serverUpdate,
}: {
  readonly engine: EngineStatus | null;
  readonly name: string;
  readonly failure: Failure | null;
  readonly onCreate: () => void;
  readonly providerActions: ProviderActions;
  readonly providerSetup: LocalProviderSetup | undefined;
  readonly serverUpdate: ServerUpdateView | undefined;
}) {
  const i18n = useI18n();
  const { t } = i18n;
  const ai = useWebAiConnect({
    engine,
    connect: connectPlaceOf(providerSetup, serverUpdate),
    actions: providerActions,
  });
  const { opened } = ai;
  const openedText = useAiText(ai, opened ?? ai.accounts["claude-code"]);
  const text = connectStepText(
    engine,
    opened === null ? null : { account: opened.account, text: openedText },
    opened?.state ?? null,
    name,
    i18n,
  );
  const waitsId = useId();
  const out = aiOutage(engine) !== null;
  // The account's own button leads while it asks something of the operator.
  const asked = out || opened === null ? null : opened.action;
  // Creating the bot leads once nothing is asked of them: no account to pick, no button of its own.
  const leads = out || (opened !== null && asked === null);
  const createWaits = text.createWaits !== null;
  return (
    <StepFrame
      actions={
        <>
          <FailureLine failure={failure} name={name} />
          {opened !== null && asked !== null ? (
            <BigButton onClick={opened.act} disabled={opened.asking === "asking"}>
              {aiActionLabel(asked, opened.account, i18n)}
            </BigButton>
          ) : (
            leads && (
              <BigButton
                onClick={onCreate}
                disabled={createWaits}
                describedBy={createWaits ? waitsId : undefined}
              >
                {t("onboarding.create", { name })}
              </BigButton>
            )
          )}
          {!leads && (
            <Button
              variant="ghost-muted"
              onClick={createWaits ? undefined : onCreate}
              aria-disabled={createWaits}
              aria-describedby={createWaits ? waitsId : undefined}
            >
              {t("onboarding.connect.createLater", { name })}
            </Button>
          )}
          {(text.createWaits ?? (leads ? text.later : null)) !== null && (
            <p id={waitsId} className="text-center text-sm text-pretty text-muted-foreground">
              {text.createWaits ?? text.later}
            </p>
          )}
        </>
      }
    >
      <StepTitle>{text.title}</StepTitle>
      {/* Live: the step says when the account connects, without moving on by itself. */}
      <p role="status" className="text-lg text-pretty text-muted-foreground">
        {text.body}
      </p>
      {!out &&
        (opened === null ? (
          <AiChoice ai={ai} />
        ) : (
          <>
            <AiAccountPanel ai={ai} account={opened} said={text.says} button={false} />
            <OtherAccount ai={ai} account={opened.account} />
          </>
        ))}
      {!out && <AdvancedEndpoint ai={ai} />}
      {text.details.length > 0 && (
        <AiDetails>
          {text.details.map((detail) => (
            <p key={detail} className="select-text">
              {detail}
            </p>
          ))}
        </AiDetails>
      )}
    </StepFrame>
  );
}

/**
 * The bot arriving. Until the server has created it, only the bot above, alone
 * in its light, says something is happening, and a line what it waits for, if
 * anything; then the stage plays its finale, its light swelling as everyone
 * cheers, the bot's name pops in under it, and a line says whether it is
 * saying hello or waits for a model.
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
      <div className="mt-6 flex flex-col items-center gap-2">
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
