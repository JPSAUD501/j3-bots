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
  showsConnect,
  showsVault,
} from "@j3-bots/client-runtime/presentation";
import { avatarCast, firstRun, springs } from "@j3-bots/design-tokens";
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
import { type ProviderActions, ProviderFix } from "../components/ProviderFix";
import { engineFindings, type LocalProviderSetup, LocalSignIn } from "../components/ProviderSetup";
import { Button } from "../components/ui/button";
import { SetupVaultForm, type VaultAccess } from "../components/vault/VaultForms";
import { cn } from "../lib/cn";
import { Cast, type Lead } from "./Cast";
import { ARRIVING, openArrived } from "./handoff";
import { BigButton, bigFieldClass, StepTitle } from "./parts";
import {
  type Box,
  boxOf,
  carryFrom,
  carryTo,
  playSpring,
  springAnimation,
  useReducedMotion,
} from "./motion";

const after = (ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms));

/** The bot above the steps, in px, and the room above and under it, which every step but the welcome leaves free. */
const HERO_SIZE = 96;
const HERO_ABOVE = 16;
const HERO_BELOW = 24;
const HERO_ROOM = HERO_ABOVE + HERO_SIZE + HERO_BELOW;
/**
 * Where the arrival's title starts under that room, below the farthest ring,
 * so no ring crosses it: the ring's radius, less how far the grown bot's
 * centre sits above the room's end, and a little space.
 */
const ARRIVAL_TITLE_TOP =
  (HERO_SIZE * (1 + firstRun.arrivalGrowth) * firstRun.rings.reach) / 2 -
  (HERO_SIZE / 2 + HERO_BELOW - firstRun.arrivalDrop) +
  12;

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
  /** Where it starts: the welcome, or another step for the gallery. */
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
  /** The server's vault: while it has no password, a step offers to set one. */
  readonly vault?: VaultAccess;
}

type Direction = "forward" | "back";

/** Why the bot was not created: the server has no model for it, or anything else. */
type Failure = "no-model" | "other";

/**
 * The first run, from the welcome to the first bot's arrival, one thing per
 * screen. Each screen slides in from the side it comes from, and Back always
 * returns to the one before. The bot being made is the cast's first bot,
 * carried from the welcome to its place above the screens and back; there it
 * answers what the operator does, and once it exists it travels on into its
 * conversation. Continue always works: the name and the look have defaults,
 * and a provider that is not connected yet never holds the bot back, which
 * then says hello once one is.
 */
export function Onboarding({
  engine,
  onCreate,
  onArrived,
  providerActions,
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
    /** The screen going away, while it does: a new one at each move, so its exit restarts even for the same step. */
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

  // The cast's first bot is the bot being made: leaving the welcome, it is carried from where
  // the cast has it to its place above the steps, and back again on the way back.
  const leadRef = useRef<HTMLSpanElement>(null);
  const heroRef = useRef<HTMLSpanElement>(null);
  const stepsRef = useRef<HTMLDivElement>(null);
  const liftOff = useRef<Box | null>(null);
  const go = (to: OnboardingStep, direction: Direction) => {
    if (to === "connect") setConnectShown(true);
    if (to === "vault") setVaultShown(true);
    if (step === "welcome" && leadRef.current !== null) liftOff.current = boxOf(leadRef.current);
    setView((now) => ({
      step: to,
      direction,
      leaving: { step: now.step },
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
  // Before the first frame of a move, so the bot never shows where it is not.
  useLayoutEffect(() => {
    const hero = heroRef.current;
    if (reduced || hero === null || view.leaving === null) return;
    if (view.leaving.step === "welcome") {
      const from = liftOff.current;
      liftOff.current = null;
      if (from === null) return;
      const carry = carryFrom(hero, from);
      return () => carry.cancel();
    }
    const lead = leadRef.current;
    const layer = currentRef.current;
    const steps = stepsRef.current;
    if (view.step !== "welcome" || lead === null || layer === null || steps === null) return;
    const carry = carryTo(hero, restingBox(lead, layer, steps));
    return () => carry.cancel();
  }, [reduced, view.leaving, view.step, heroRef, liftOff, leadRef, stepsRef]);

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
        void after(reduced ? 0 : firstRun.hold).then(() =>
          openArrived(result.value, () => onArrived(result.value), !reduced),
        );
      },
      () => failed("other"),
    );
  };

  const progress = makingProgress(step, flow);
  const canGoBack = previousStep(step, flow) !== null;
  // The bot being made stays while a step it stands over goes away, so it can be carried home.
  const heroShown =
    step !== "welcome" || (view.leaving !== null && view.leaving.step !== "welcome");
  // Where the bot being made stands for the cast's first bot, the cast leaves it out; it comes back
  // once the bot being made is carried home. Under reduced motion the two only crossfade.
  const castLead = (current: boolean): Lead =>
    reduced
      ? "pops"
      : !current || view.leaving !== null
        ? "away"
        : view.move === 0
          ? "pops"
          : "still";
  const style: CSSProperties & Record<"--onboarding-bot", string> = {
    "--onboarding-bot": `var(--bot-${look.color})`,
  };

  const screen = (at: OnboardingStep, current: boolean): ReactNode => {
    switch (at) {
      case "welcome":
        return (
          <Welcome
            onStart={forward}
            footer={footer}
            lead={castLead(current)}
            leadRef={leadRef}
            rises={view.move === 0 && !reduced}
          />
        );
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
        <div ref={stepsRef} className="relative min-h-0 flex-1">
          {view.leaving !== null && (
            <Layer
              key={`out:${view.move}`}
              motion={`out-${view.direction}`}
              reduced={reduced}
              room={view.leaving.step !== "welcome"}
            >
              {screen(view.leaving.step, false)}
            </Layer>
          )}
          <Layer
            key={`in:${view.move}`}
            ref={currentRef}
            motion={view.move === 0 ? null : `in-${view.direction}`}
            reduced={reduced}
            room={step !== "welcome"}
          >
            {screen(step, true)}
          </Layer>
          {heroShown && (
            <Hero
              ref={heroRef}
              look={look}
              pokes={pokes}
              arrived={step === "arrival" && created}
              reduced={reduced}
              entrance={view.move === 0 ? "pop" : reduced ? "fade" : "carried"}
              departing={reduced && step === "welcome"}
            />
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * Where the cast's first bot rests in the welcome coming in: where it is
 * drawn, less how far the welcome's screen is from its place as it slides in.
 */
const restingBox = (lead: Element, layer: Element, steps: Element): Box => {
  const box = boxOf(lead);
  const layerBox = layer.getBoundingClientRect();
  const stepsBox = steps.getBoundingClientRect();
  return {
    x: box.x - (layerBox.x - stepsBox.x),
    y: box.y - (layerBox.y - stepsBox.y),
    width: box.width,
  };
};

/**
 * One screen of the first run; the one going away is hidden from everything
 * but the eye. A screen comes in from the side it comes from as the other
 * leaves the same way; under reduced motion the two only crossfade. Every
 * screen but the welcome leaves room at its top for the bot being made.
 */
function Layer({
  motion,
  reduced,
  room,
  children,
  ref,
}: {
  readonly motion: `${"in" | "out"}-${Direction}` | null;
  readonly reduced: boolean;
  readonly room: boolean;
  readonly children: ReactNode;
  readonly ref?: Ref<HTMLDivElement>;
}) {
  const leaving = motion?.startsWith("out") === true;
  const sign = motion?.endsWith("back") === true ? -1 : 1;
  const style: CSSProperties & Partial<Record<"--onboarding-shift", string>> =
    motion === null
      ? {}
      : reduced
        ? {
            animation: `${leaving ? "onboarding-fade-out" : "onboarding-fade-in"} var(--duration-state) var(--ease-out) both`,
          }
        : leaving
          ? {
              animation: `onboarding-out ${firstRun.leave}ms var(--ease-out) both`,
              "--onboarding-shift": `${-sign * firstRun.shift}px`,
            }
          : {
              animation: springAnimation("onboarding-in"),
              "--onboarding-shift": `${sign * firstRun.shift}px`,
            };
  return (
    <div
      ref={ref}
      className={cn(
        "absolute inset-0 flex flex-col",
        leaving && "pointer-events-none",
        reduced && "crossfade",
      )}
      style={{ ...style, paddingTop: room ? HERO_ROOM : 0 }}
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
 * The bot being made, over the top of the screens: carried there from the
 * cast, it hops at every step and every change, morphs into a new shape, and
 * grows when it arrives, with rings in its colour. From there it travels into
 * its conversation (`openArrived`). Under reduced motion it fades in and out
 * and keeps still.
 */
function Hero({
  look,
  pokes,
  arrived,
  reduced,
  entrance,
  departing,
  ref,
}: {
  readonly look: AvatarChoice;
  readonly pokes: number;
  readonly arrived: boolean;
  readonly reduced: boolean;
  /** Popping in where the first run starts past the welcome; otherwise carried, or faded in. */
  readonly entrance: "pop" | "carried" | "fade";
  /** Going away under reduced motion, as the welcome comes back. */
  readonly departing: boolean;
  /** What carries it to and from the cast. */
  readonly ref: Ref<HTMLSpanElement>;
}) {
  const bot = useRef<AvatarHandle>(null);
  const hop = useRef<HTMLSpanElement>(null);
  const shape = useRef(look.shape);
  useEffect(() => {
    if (look.shape !== shape.current) bot.current?.poke("morph");
    shape.current = look.shape;
  }, [look.shape]);
  useEffect(() => {
    if (pokes === 0 || reduced || hop.current === null) return;
    const landing = playSpring(
      hop.current,
      [{ transform: `translateY(${-firstRun.hop}px) scale(1.06, 0.95)` }, { transform: "none" }],
      "pop",
    );
    return () => landing.cancel();
  }, [pokes, reduced]);
  const grown = `translateY(${firstRun.arrivalDrop}px) scale(${1 + firstRun.arrivalGrowth})`;
  const rings: CSSProperties & Record<"--onboarding-reach", string> = {
    color: "var(--onboarding-bot)",
    "--onboarding-reach": String(firstRun.rings.reach),
  };
  return (
    <div
      aria-hidden
      className={cn(
        "pointer-events-none absolute inset-x-0 top-0 z-10 flex justify-center [--avatar-cutout:var(--background)]",
        (entrance === "fade" || departing) && "crossfade",
      )}
      style={{
        paddingTop: HERO_ABOVE,
        animation: departing
          ? "onboarding-fade-out var(--duration-state) var(--ease-out) both"
          : entrance === "fade"
            ? "onboarding-fade-in var(--duration-state) var(--ease-out) both"
            : undefined,
      }}
    >
      <span ref={ref} className="block">
        <span
          className="relative block transition-transform duration-(--duration-pop) ease-pop"
          style={{ transform: arrived ? grown : "none" }}
        >
          {arrived && (
            <span className="absolute inset-0" style={rings}>
              {Array.from({ length: firstRun.rings.count }, (_, ring) => (
                <span
                  key={ring}
                  className="absolute inset-0 rounded-full border-2 border-current"
                  style={{
                    animation: `onboarding-ring ${firstRun.rings.duration}ms var(--ease-out) calc(var(--duration-pop) / 2 + ${ring * firstRun.rings.gap}ms) both`,
                  }}
                />
              ))}
            </span>
          )}
          <span ref={hop} className={cn("block", entrance === "pop" && "pop-in")}>
            {/* What travels into the conversation's header once the bot is there. */}
            <span
              className="block"
              style={{ viewTransitionName: arrived && !reduced ? ARRIVING : undefined }}
            >
              <BotAvatar ref={bot} avatar={look} seed="first-bot" state="idle" size={HERO_SIZE} />
            </span>
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

/**
 * The first screen: the cast, what J3 Bots is, and the way in. When it `rises`,
 * the first time it shows and only with motion, its words rise in after the
 * cast has started popping in.
 */
function Welcome({
  onStart,
  footer,
  lead,
  leadRef,
  rises,
}: {
  readonly onStart: () => void;
  readonly footer: ReactNode;
  readonly lead: Lead;
  readonly leadRef: Ref<HTMLSpanElement>;
  readonly rises: boolean;
}) {
  const { t } = useI18n();
  const rise = (order: number): CSSProperties =>
    rises
      ? { animation: springAnimation("onboarding-rise", "soft", firstRun.stagger * order) }
      : {};
  return (
    <StepFrame
      actions={
        <div className="flex flex-col gap-3" style={rise(3)}>
          <BigButton onClick={onStart}>{t("onboarding.welcome.start")}</BigButton>
          {footer}
        </div>
      }
    >
      <div className="flex flex-1 flex-col items-center justify-center gap-6">
        <Cast lead={lead} leadRef={leadRef} />
        <div className="flex flex-col gap-3" style={rise(2)}>
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
      <div className="flex flex-col items-center gap-2" style={{ marginTop: ARRIVAL_TITLE_TOP }}>
        {created && (
          <h1
            className="display-type text-4xl"
            style={{ animation: springAnimation("pop-in", "pop", firstRun.nameDelay) }}
          >
            {t("onboarding.arrival.title", { name })}
          </h1>
        )}
        {/* Present from the start, so what it says once the bot exists is announced. */}
        <p role="status" className="text-lg text-muted-foreground">
          {created && (
            <span
              className="block"
              style={{ animation: springAnimation("onboarding-rise", "soft", firstRun.lineDelay) }}
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
