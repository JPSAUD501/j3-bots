// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  aiAccounts,
  aiOnItsWay,
  aiOutage,
  connectStepSaysProgress,
  defaultBotName,
  type Featured,
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
import { refusedWith } from "@j3-bots/client-runtime";
import { useEngineStatus, useJ3Client } from "@j3-bots/client-runtime/react";
import { connectStepText } from "@j3-bots/client-runtime/wording";
import {
  type AvatarChoice,
  type BotId,
  type EngineStatus,
  PROFILE_LIMITS,
} from "@j3-bots/contracts";
import {
  avatarCast,
  easeOutCurve,
  motion,
  reanimatedSpring,
  springs,
  stage,
} from "@j3-bots/design-tokens";
import * as ExpoCrypto from "expo-crypto";
import { Check, ChevronLeft } from "lucide-react-native";
import {
  type ComponentRef,
  type ReactNode,
  type Ref,
  useEffect,
  useEffectEvent,
  useRef,
  useState,
} from "react";
import {
  ActivityIndicator,
  BackHandler,
  I18nManager,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  View,
} from "react-native";
import Animated, {
  Easing,
  type EntryAnimationsValues,
  type ExitAnimationsValues,
  FadeIn,
  type LayoutAnimation,
  FadeOut,
  ReduceMotion,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
} from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Svg, { Defs, RadialGradient, Rect, Stop } from "react-native-svg";
import { AvatarChoices } from "../components/avatar/AvatarPicker.tsx";
import { type AvatarHandle, BotAvatar } from "../components/avatar/BotAvatar.tsx";
import { AiConnect, AiDetails, useMobileAiConnect } from "../components/AiConnect.tsx";
import { Icon } from "../components/Icon.tsx";
import { SettingsEntry } from "../components/SettingsEntry.tsx";
import { useI18n } from "../i18n.ts";
import { popIn, settleIn, useReducedMotion } from "../motion.ts";
import { useColor } from "../theme.ts";
import { useTint } from "../conversation/tint.ts";
import { PressScale } from "../press.tsx";
import { Button } from "../ui.tsx";
import { displaySpacing, Text, TextInput } from "../text.tsx";
import { type Box, boxFrom, sendOff, useSentOff } from "./handoff.tsx";
import { BigButton, bigFieldClass, Cast, Light, StepTitle } from "./parts.tsx";
import { clearProgress, readProgress, writeProgress } from "./progress.ts";

const soft = reanimatedSpring(springs.soft);
const slide = reanimatedSpring(springs.slide);
const easeOut = Easing.bezier(...easeOutCurve);

/** The bot above the steps, in px, and the room above and under it, which every step but the welcome leaves free; under it, its name. */
const HERO_SIZE = 96;
const HERO_ABOVE = 20;
const HERO_BELOW = 44;
const HERO_ROOM = HERO_ABOVE + HERO_SIZE + HERO_BELOW;
/** The cast above the story's steps: the room above it, and what it and that room take of the steps' top, in px. */
const CAST_ABOVE = 28;
const CAST_HEIGHT = 192;
const STORY_ROOM = CAST_ABOVE + CAST_HEIGHT + 8;
/** How long "ready" stays once what was being prepared is, in ms, before the line goes. */
const READY_STAYS = 2600;

const after = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Why the bot was not created: the server has no model for it, or anything else. */
type Failure = "no-model" | "other";

/** A crossfade, which reduced motion keeps: it moves nothing. */
const fadeIn = FadeIn.duration(motion.state).reduceMotion(ReduceMotion.Never);
const fadeOut = FadeOut.duration(motion.state).reduceMotion(ReduceMotion.Never);

/** A step's lines arriving under the stage: up into place on `soft` as they clear, as the web's pull into focus. */
const arrive = settleIn(springs.soft);
/** The step before giving way at once, so the new lines never wait for it. */
const giveWay = FadeOut.duration(stage.leave).easing(easeOut);

/*
 * The carries work in the steps' space. The bot being made is held at the
 * steps' top left, so where a layout animation says it is, which is relative
 * to its holder, is where it is in the steps; `home` is measured against them.
 */

/** The bot being made carried from `from`, the cast's first bot, to its place above the steps, on `slide`. */
const carryIn =
  (from: Box) =>
  (values: EntryAnimationsValues): LayoutAnimation => {
    "worklet";
    const x = values.targetOriginX + values.targetWidth / 2;
    const y = values.targetOriginY + values.targetHeight / 2;
    return {
      initialValues: {
        transform: [
          { translateX: from.x - x },
          { translateY: from.y - y },
          { scale: from.width / values.targetWidth },
        ],
      },
      animations: {
        transform: [
          { translateX: withSpring(0, slide) },
          { translateY: withSpring(0, slide) },
          { scale: withSpring(1, slide) },
        ],
      },
    };
  };

/** And carried back home to `to`, as the welcome comes back. */
const carryOut =
  (to: Box) =>
  (values: ExitAnimationsValues): LayoutAnimation => {
    "worklet";
    const x = values.currentOriginX + values.currentWidth / 2;
    const y = values.currentOriginY + values.currentHeight / 2;
    return {
      initialValues: { transform: [{ translateX: 0 }, { translateY: 0 }, { scale: 1 }] },
      animations: {
        transform: [
          { translateX: withSpring(to.x - x, slide) },
          { translateY: withSpring(to.y - y, slide) },
          { scale: withSpring(to.width / values.currentWidth, slide) },
        ],
      },
    };
  };

/**
 * The first run, from the welcome to the first bot's arrival, played on a
 * stage as on the web. It opens by saying what J3 Bots is, in three steps the
 * cast carries, standing above them: it comes down into its lights; the light
 * goes from one bot to the next as each says what it does for the operator;
 * then they think, under the one light they share. The bot being made is the
 * cast's first bot, carried closer to its place above the steps and back, and
 * each step's lines arrive under it. There it answers what the operator does
 * with its own motion: it looks down at the name as it is typed and wears it,
 * takes each shape and color as it is picked, and once it exists its light
 * swells, it cheers, and it travels on into its conversation (`sendOff`).
 * Under every step one quiet line says what the server is still getting ready
 * (`Preparing`), which holds nothing back. Back returns to the step before, and Continue
 * always works: a provider not connected yet never holds the bot back, which
 * says hello once one is. Put away mid-way, it starts again where it was
 * (`progress.ts`). Every move runs on the UI thread; under reduced motion the
 * steps and the bot only crossfade.
 */
export function Onboarding({
  onCreating,
  onArrived,
}: {
  /** Told when the bot is being created, and again if it was not. */
  readonly onCreating: (creating: boolean) => void;
  /** Opens the new bot's conversation, which ends the first run. */
  readonly onArrived: (botId: BotId) => void;
}) {
  // The cast's first bot, and the bot being made's place, which its arrival sets off from.
  const leadRef = useRef<ComponentRef<typeof View>>(null);
  const heroRef = useRef<ComponentRef<typeof View>>(null);
  const stepsRef = useRef<ComponentRef<typeof View>>(null);
  // Where the cast's first bot is, in the steps: set as the bot being made leaves it, which the cast then
  // draws without it for a frame before it gives way; kept to carry it back there.
  const [home, setHome] = useState<Box | null>(null);
  const [lifting, setLifting] = useState(false);
  const i18n = useI18n();
  const { t } = i18n;
  const insets = useSafeAreaInsets();
  const client = useJ3Client();
  const status = useEngineStatus();
  const engine = status._tag === "ready" ? status.value : null;
  const reduced = useReducedMotion();
  const [seed] = useState(() => ExpoCrypto.getRandomBytes(1)[0] ?? 0);
  // What this phone left the first run at.
  const [saved] = useState(readProgress);
  // In the language the operator reads now, until they type one of their own.
  const fallbackName = defaultBotName(i18n.locale, seed);
  const [typed, setTyped] = useState<string | null>(saved?.name ?? null);
  const name = typed ?? fallbackName;
  const [look, setLook] = useState<AvatarChoice>(saved?.look ?? avatarCast[0]);
  const [failure, setFailure] = useState<Failure | null>(null);
  // Where it starts: the welcome, or the step this phone left it at.
  const [started] = useState<OnboardingStep>(() =>
    saved === null ? "welcome" : resumedStep(saved.step, { connect: showsConnect(engine, false) }),
  );
  // Whether the connect step was shown: from then on it stays in the flow (`showsConnect`).
  // Starting on it counts, so a provider that connects while the operator reads it does not
  // take the step, its dot and the way Back away under them.
  const [connectShown, setConnectShown] = useState(started === "connect");
  // Whether the bot exists: the arrival names it only then.
  const [created, setCreated] = useState(false);
  const flow: OnboardingFlow = {
    connect: showsConnect(engine, connectShown),
  };
  const [view, setView] = useState<{
    readonly step: OnboardingStep;
    readonly move: number;
  }>({ step: started, move: 0 });
  const { step } = view;
  const botName = name.trim() === "" ? fallbackName : name.trim();
  // The bot being made, which answers what the operator does.
  const bot = useRef<AvatarHandle>(null);
  // Whether the cast is back on after the steps that make the bot, where the bot being made is
  // carried home into it, or on for the first time, where the whole cast comes down.
  const [castBack, setCastBack] = useState(false);
  // Whose turn in the light it is, while the cast says what it does: it goes once round, a line
  // each, and rests on the last, which is everyone's.
  const [turn, setTurn] = useState(0);
  useEffect(() => {
    if (step !== "work" || reduced || turn >= workExamples.length - 1) return;
    const next = setTimeout(() => setTurn(turn + 1), stage.turn);
    return () => clearTimeout(next);
  }, [step, reduced, turn]);

  // Kept as it goes, so putting the app away does not start the first run over.
  useEffect(() => {
    if (!created) writeProgress({ step, name: typed, look });
  }, [created, step, typed, look]);

  const go = (to: OnboardingStep) => {
    if (to === "connect") setConnectShown(true);
    if (to === "work") setTurn(0);
    if (tellsStory(to) && !tellsStory(step)) setCastBack(true);
    setView((now) => ({ step: to, move: now.move + 1 }));
    // The bot being made takes each step with the operator.
    if (!tellsStory(to)) bot.current?.poke(to === "arrival" ? "hover" : "nod");
  };
  // Leaving the story, the bot being made first takes the cast's first bot's place, and once it
  // is laid out there the cast goes (`lifted`): so the cast leaves without it.
  const leaveStory = () => {
    // Already on its way: a second tap must not lift it again.
    if (lifting) return;
    const lead = leadRef.current;
    const steps = stepsRef.current;
    if (reduced || lead === null || steps === null) {
      go("name");
      return;
    }
    lead.measureLayout(
      steps,
      (x, y, width, height) => {
        setHome(boxFrom(x, y, width, height));
        setLifting(true);
      },
      () => go("name"),
    );
  };
  const lifted = () => {
    setLifting(false);
    go("name");
  };

  const create = () => {
    setFailure(null);
    const from = step;
    go("arrival");
    onCreating(true);
    // The first bot is the primary one, and its title says so.
    const draft = { name: botName, title: t("bot.primaryTitle"), primary: true, avatar: look };
    void client.createBot(draft).then((result) => {
      if (result._tag !== "done") {
        onCreating(false);
        setFailure(refusedWith(result, "model") ? "no-model" : "other");
        go(from);
        return;
      }
      // The bot exists: it is seen arriving before its conversation opens, then travels into it.
      clearProgress();
      setCreated(true);
      bot.current?.poke("cheer");
      void after(reduced ? 0 : stage.hold).then(() => {
        const hero = heroRef.current;
        if (reduced || hero === null) {
          onArrived(result.value.id);
          return;
        }
        hero.measureInWindow((x, y, width) => {
          // Where the bot is drawn: its place, as close as the steps showed it.
          sendOff(result.value.id, look, {
            x: x + width / 2,
            y: y + HERO_ABOVE + HERO_SIZE / 2,
            width: HERO_SIZE * stage.close,
          });
          onArrived(result.value.id);
        });
      });
    });
  };

  const forward = () => {
    const to = nextStep(step, flow);
    if (to === null) return;
    if (to === "arrival") create();
    else if (tellsStory(step) && !tellsStory(to)) leaveStory();
    else go(to);
  };
  const back = () => {
    const to = previousStep(step, flow);
    if (to !== null) go(to);
  };
  const canGoBack = previousStep(step, flow) !== null;
  const progress = stepProgress(step, flow);
  const story = tellsStory(step);
  const featured: Featured = step === "work" && !reduced ? workTurn(turn).featured : "all";

  // The system's Back goes to the step before, as the one on screen does, and
  // does nothing while the bot arrives; from the welcome it leaves the app.
  const onSystemBack = useEffectEvent((): boolean => {
    if (step === "arrival") return true;
    if (previousStep(step, flow) === null) return false;
    back();
    return true;
  });
  useEffect(() => {
    const subscription = BackHandler.addEventListener("hardwareBackPress", () => onSystemBack());
    return () => subscription.remove();
  }, []);

  let screen: ReactNode;
  switch (step) {
    case "welcome":
      screen = <Welcome onContinue={forward} first={view.move === 0} />;
      break;
    case "work":
      screen = <WorkStep turn={turn} reduced={reduced} onContinue={forward} />;
      break;
    case "mind":
      screen = <MindStep onContinue={forward} />;
      break;
    case "name":
      screen = (
        <NameStep
          name={name}
          fallback={fallbackName}
          onName={(next) => {
            setTyped(next);
            bot.current?.poke("type");
          }}
          onContinue={forward}
        />
      );
      break;
    case "look":
      screen = (
        <LookStep
          name={botName}
          look={look}
          onLook={(next) => {
            // A new shape is taken in a squash; a new color is good news.
            bot.current?.poke(next.shape === look.shape ? "hop" : "morph");
            setLook(next);
          }}
          ready={nextStep("look", flow) === "arrival"}
          failure={failure}
          onContinue={forward}
        />
      );
      break;
    case "connect":
      screen = <ConnectStep engine={engine} name={botName} failure={failure} onCreate={create} />;
      break;
    case "arrival":
      screen = <Arrival engine={engine} name={botName} created={created} />;
      break;
  }

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === "ios" ? "padding" : "height"}
      className="flex-1 bg-background"
      style={{ paddingTop: insets.top, paddingBottom: insets.bottom }}
    >
      <View className="h-14 flex-row items-center px-2">
        <View className="w-11">
          {canGoBack && (
            <PressScale
              depth="round"
              accessibilityRole="button"
              accessibilityLabel={t("onboarding.back")}
              onPress={back}
              className="size-11 items-center justify-center rounded-pill active:bg-muted"
            >
              <View style={I18nManager.isRTL ? { transform: [{ scaleX: -1 }] } : undefined}>
                <Icon icon={ChevronLeft} size={22} color="accent-muted-foreground" />
              </View>
            </PressScale>
          )}
        </View>
        <View className="flex-1 items-center">
          {progress !== null && <Progress {...progress} />}
        </View>
        {/* Settings is in reach before the first bot: devices, the server, signing out, the language. */}
        <View className="w-11">{step === "welcome" && <SettingsEntry />}</View>
      </View>
      {/* Nothing here is cut at its edge: the lights reach up past the steps, as from a rig above. */}
      <View ref={stepsRef} className="flex-1">
        {/* The cast stays up while the story's steps change under it; only its lights change. */}
        {story && (
          <Animated.View
            pointerEvents="none"
            className="absolute inset-x-0 top-0 items-center"
            style={{ paddingTop: CAST_ABOVE }}
            {...(castBack ? { entering: fadeIn } : {})}
            exiting={reduced ? fadeOut : giveWay}
          >
            <Cast
              scene={stageScene(step, false)}
              featured={featured}
              look={look}
              leadRef={leadRef}
              lead={reduced ? "pops" : lifting ? "away" : castBack ? "after" : "pops"}
            />
          </Animated.View>
        )}
        {/* Under the step's words, which it must not wash over. */}
        {step === "arrival" && created && !reduced && <Bloom look={look} />}
        <Animated.View
          key={view.move}
          className="flex-1"
          style={{ paddingTop: story ? STORY_ROOM : HERO_ROOM }}
          {...(view.move === 0 ? {} : { entering: reduced ? fadeIn : arrive })}
          exiting={reduced ? fadeOut : giveWay}
        >
          {screen}
        </Animated.View>
        {(!story || lifting) && (
          <Hero
            ref={heroRef}
            botRef={bot}
            look={look}
            name={step === "name" || step === "look" || step === "connect" ? botName : null}
            arrived={step === "arrival" && created}
            tight={step === "connect" || (step === "arrival" && !created)}
            reduced={reduced}
            home={home}
            {...(lifting ? { onPlaced: lifted } : {})}
          />
        )}
      </View>
      <Preparing
        engine={engine}
        quiet={step === "arrival" || (step === "connect" && connectStepSaysProgress(engine))}
      />
    </KeyboardAvoidingView>
  );
}

/** Where the bot is among the steps that make it: one dot each, the current one long. */
function Progress({ index, count }: { readonly index: number; readonly count: number }) {
  const { t } = useI18n();
  return (
    <View
      accessible
      accessibilityLabel={t("onboarding.progress", { current: index + 1, count })}
      className="flex-row items-center gap-1.5"
    >
      {Array.from({ length: count }, (_, dot) => (
        <Dot key={dot} current={dot === index} />
      ))}
    </View>
  );
}

function Dot({ current }: { readonly current: boolean }) {
  const width = useSharedValue(current ? 20 : 6);
  useEffect(() => {
    width.set(withSpring(current ? 20 : 6, soft));
  }, [current, width]);
  const style = useAnimatedStyle(() => ({ width: width.get() }));
  return (
    <Animated.View
      className={`h-1.5 rounded-full bg-foreground ${current ? "" : "opacity-25"}`}
      style={style}
    />
  );
}

/**
 * The bot being made, over the top of the steps, in its own light: carried
 * there from the cast and back (`home`), drawn closer than the cast was, as
 * the web's camera closes in. It wears its name once it has one. What the
 * operator does it answers with its own motion (`botRef`), and when it exists
 * its light swells and settles as a glow opens around it and goes. Once sent
 * off into its conversation, the bot in flight stands for it. Under reduced
 * motion it fades in and out and keeps still.
 */
function Hero({
  look,
  name,
  arrived,
  tight,
  reduced,
  home,
  onPlaced,
  ref,
  botRef,
}: {
  readonly look: AvatarChoice;
  /** The name it wears under its feet; null where it wears none. */
  readonly name: string | null;
  readonly arrived: boolean;
  /** Whether its light is closed around it, as while a form has the operator's eye. */
  readonly tight: boolean;
  readonly reduced: boolean;
  /** Where the cast's first bot is, which the bot being made is carried from and back to. */
  readonly home: Box | null;
  /** Told once it is laid out, as it starts being carried. */
  readonly onPlaced?: () => void;
  /** Its place, which its arrival sets off from. */
  readonly ref: Ref<ComponentRef<typeof View>>;
  /** What makes it answer. */
  readonly botRef: Ref<AvatarHandle>;
}) {
  // How large it is drawn: closer than the cast.
  const scale = useSharedValue(1);
  useEffect(() => {
    scale.set(reduced ? stage.close : withSpring(stage.close, soft));
  }, [reduced, scale]);
  const style = useAnimatedStyle(() => ({ transform: [{ scale: scale.get() }] }));
  const sentOff = useSentOff();
  return (
    <View
      ref={ref}
      pointerEvents="none"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      className="absolute inset-x-0 top-0 items-center"
      style={{ paddingTop: HERO_ABOVE, zIndex: 1, opacity: sentOff ? 0 : 1 }}
      onLayout={() => onPlaced?.()}
    >
      <Animated.View
        entering={reduced || home === null ? fadeIn : carryIn(home)}
        exiting={reduced || home === null ? fadeOut : carryOut(home)}
      >
        <Animated.View style={style}>
          <Light
            look={look}
            size={HERO_SIZE}
            delay={0}
            light="key"
            tight={tight}
            swells={arrived}
            dusty
          />
          <BotAvatar ref={botRef} avatar={look} seed="first-bot" state="idle" size={HERO_SIZE} />
        </Animated.View>
      </Animated.View>
      {name !== null && (
        <Animated.View
          entering={reduced ? fadeIn : popIn(springs.slide.duration / 2)}
          exiting={fadeOut}
          className="mt-3.5 max-w-56 rounded-pill bg-muted px-2.5 py-0.5"
        >
          <Text numberOfLines={1} className="text-xs font-semibold text-foreground">
            {name}
          </Text>
        </Animated.View>
      )}
    </View>
  );
}

/** How wide the finale's glow is, in bot sizes. */
const BLOOM = 5.2;

/**
 * The finale's glow: it opens around the bot being made as its light swells,
 * and goes, in the bot's color, soft at its edge, so nothing of it is ever
 * cut. It is laid over the steps' top, centred on the bot, and goes under the
 * step's words.
 */
function Bloom({ look }: { readonly look: AvatarChoice }) {
  const color = useTint(look).color;
  const opened = useSharedValue(0);
  useEffect(() => {
    opened.set(withTiming(1, { duration: stage.swell, easing: easeOut }));
  }, [opened]);
  const style = useAnimatedStyle(() => {
    const at = opened.get();
    return {
      // Up over the first quarter, then away.
      opacity: at < 0.26 ? at / 0.26 : 1 - (at - 0.26) / 0.74,
      transform: [{ scale: 0.45 + 0.67 * at }],
    };
  });
  const across = HERO_SIZE * BLOOM;
  return (
    <View
      pointerEvents="none"
      className="absolute inset-x-0 items-center"
      style={{ top: HERO_ABOVE + HERO_SIZE / 2 - across / 2 }}
    >
      <Animated.View style={[{ width: across, height: across }, style]}>
        <Svg width={across} height={across}>
          <Defs>
            <RadialGradient id="bloom" cx="0.5" cy="0.5" r="0.5">
              <Stop offset="0" stopColor={color} stopOpacity={0.34} />
              <Stop offset="0.32" stopColor={color} stopOpacity={0.17} />
              <Stop offset="0.62" stopColor={color} stopOpacity={0.06} />
              <Stop offset="1" stopColor={color} stopOpacity={0} />
            </RadialGradient>
          </Defs>
          <Rect width={across} height={across} fill="url(#bloom)" />
        </Svg>
      </Animated.View>
    </View>
  );
}

/**
 * What the server is still getting ready, in one quiet line under every step:
 * the engine and the harnesses it downloads, with how far they are when the
 * server says. It holds nothing back, takes its room whether it says anything
 * or not, so nothing moves when it does, and says "ready" once, only after it
 * was seen getting ready. `quiet` keeps it silent where the step says the
 * same itself: the arrival, which says what it waits for under the bot, and
 * the connect step while an account's row shows its own download or check,
 * or J3 Bots is out (`connectStepSaysProgress`).
 */
function Preparing({
  engine,
  quiet,
}: {
  readonly engine: EngineStatus | null;
  readonly quiet: boolean;
}) {
  const { t, locale } = useI18n();
  const muted = useColor("accent-muted-foreground");
  // A phone's bots live on a server it pairs with: it never starts one.
  const now = gettingReady(engine, false);
  const [prepared, setPrepared] = useState<"never" | "under-way" | "said">("never");
  if (now._tag === "preparing" && prepared !== "under-way") setPrepared("under-way");
  const ready = now._tag === "ready" && prepared === "under-way";
  useEffect(() => {
    if (!ready) return;
    const said = setTimeout(() => setPrepared("said"), READY_STAYS);
    return () => clearTimeout(said);
  }, [ready]);
  const share = readyingShare(now);
  const line =
    quiet || (now._tag !== "preparing" && !ready)
      ? null
      : t(ready ? "onboarding.prepared" : "onboarding.preparing");
  return (
    <View accessibilityLiveRegion="polite" className="h-8 flex-row items-center justify-center">
      {line !== null && (
        <Animated.View
          key={ready ? "ready" : "preparing"}
          entering={fadeIn}
          exiting={fadeOut}
          accessible
          accessibilityLabel={line}
          className="flex-row items-center gap-2"
        >
          {ready ? (
            <Icon icon={Check} size={14} color="accent-success" />
          ) : (
            <ActivityIndicator size="small" color={muted} style={{ transform: [{ scale: 0.6 }] }} />
          )}
          <Text className="text-xs text-muted-foreground">{line}</Text>
          {share !== null && (
            <Text className="text-xs text-muted-foreground tabular-nums">
              {new Intl.NumberFormat(locale, { style: "percent" }).format(share)}
            </Text>
          )}
        </Animated.View>
      )}
    </View>
  );
}

/** The content of a step, scrolling if it must, then its actions at the bottom. */
function StepFrame({
  children,
  actions,
}: {
  readonly children: ReactNode;
  readonly actions: ReactNode;
}) {
  return (
    <View className="flex-1 px-6 pb-2">
      <ScrollView
        className="flex-1"
        keyboardShouldPersistTaps="handled"
        contentContainerClassName="grow items-center gap-3"
      >
        {children}
      </ScrollView>
      <View className="gap-3 pt-4">{actions}</View>
    </View>
  );
}

/**
 * The first screen, under the cast as it comes down: what J3 Bots is, in one
 * sentence. The first time it shows, its words arrive as the cast does.
 */
function Welcome({
  onContinue,
  first,
}: {
  readonly onContinue: () => void;
  readonly first: boolean;
}) {
  const { t } = useI18n();
  return (
    <StepFrame actions={<BigButton label={t("onboarding.continue")} onPress={onContinue} />}>
      <Animated.View
        className="items-center gap-3"
        {...(first ? { entering: settleIn(springs.soft).delay(stage.focus.gap) } : {})}
      >
        <StepTitle size="display">J3 Bots</StepTitle>
        <Text className="max-w-xs text-center text-lg text-muted-foreground">
          {t("onboarding.welcome.body")}
        </Text>
      </Animated.View>
    </StepFrame>
  );
}

/**
 * What the bots do day to day. Each bot says its own line as the light comes
 * to it, one line on screen at a time, and the last is everyone's. A screen
 * reader gets them all at once, and reduced motion shows them as one list,
 * with the whole cast lit.
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
  const lines = workExamples.map((each) => t(`onboarding.work.${each}`));
  return (
    <StepFrame actions={<BigButton label={t("onboarding.continue")} onPress={onContinue} />}>
      <StepTitle>{t("onboarding.work.title")}</StepTitle>
      {reduced ? (
        <View className="gap-1">
          {lines.map((line) => (
            <Text key={line} className="text-center text-base text-muted-foreground">
              {line}
            </Text>
          ))}
        </View>
      ) : (
        <View accessible accessibilityLabel={lines.join(" ")} className="min-h-14 w-full max-w-xs">
          <Animated.Text
            key={example}
            entering={settleIn(springs.soft)}
            exiting={giveWay}
            className="absolute inset-x-0 top-0 text-center text-xl text-foreground"
          >
            {t(`onboarding.work.${example}`)}
          </Animated.Text>
        </View>
      )}
    </StepFrame>
  );
}

/** What the bots think with, which is what J3 Bots installs: the last of the story, and the way to the first bot. */
function MindStep({ onContinue }: { readonly onContinue: () => void }) {
  const { t } = useI18n();
  return (
    <StepFrame actions={<BigButton label={t("onboarding.meet")} onPress={onContinue} />}>
      <StepTitle>{t("onboarding.mind.title")}</StepTitle>
      <Text className="max-w-xs text-center text-lg text-muted-foreground">
        {t("onboarding.mind.body")}
      </Text>
    </StepFrame>
  );
}

function NameStep({
  name,
  fallback,
  onName,
  onContinue,
}: {
  readonly name: string;
  readonly fallback: string;
  readonly onName: (name: string) => void;
  readonly onContinue: () => void;
}) {
  const { t } = useI18n();
  const placeholder = useColor("accent-muted-foreground");
  return (
    <StepFrame actions={<BigButton label={t("onboarding.continue")} onPress={onContinue} />}>
      <StepTitle>{t("onboarding.name.title")}</StepTitle>
      <TextInput
        accessibilityLabel={t("onboarding.name.label")}
        accessibilityHint={t("onboarding.name.hint")}
        value={name}
        onChangeText={onName}
        placeholder={fallback}
        placeholderTextColor={placeholder}
        maxLength={PROFILE_LIMITS.name}
        autoCapitalize="words"
        autoCorrect={false}
        selectTextOnFocus
        returnKeyType="next"
        onSubmitEditing={onContinue}
        face="display"
        className={`${bigFieldClass} mt-2 w-full border-transparent text-center text-3xl focus:border-foreground`}
        style={{ letterSpacing: displaySpacing(30) }}
      />
      <Text className="text-center text-sm text-muted-foreground">{t("onboarding.name.hint")}</Text>
    </StepFrame>
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
          <BigButton
            label={ready ? t("onboarding.create", { name }) : t("onboarding.continue")}
            onPress={onContinue}
          />
        </>
      }
    >
      <StepTitle>{t("onboarding.look.title", { name })}</StepTitle>
      <View className="mt-2 w-full max-w-80">
        <AvatarChoices value={look} onChange={onLook} />
      </View>
      <Text className="text-center text-sm text-muted-foreground">{t("onboarding.look.hint")}</Text>
    </StepFrame>
  );
}

/** Why the bot was not created. */
function FailureLine({
  failure,
  name,
}: {
  readonly failure: Failure | null;
  readonly name: string;
}) {
  const { t } = useI18n();
  if (failure === null) return null;
  return (
    <Text
      accessibilityLiveRegion="polite"
      role="alert"
      className="text-center text-sm text-blocked"
    >
      {t(failure === "no-model" ? "onboarding.failedNoModel" : "onboarding.failed", { name })}
    </Text>
  );
}

/**
 * The AI the bot thinks with, asked as one question, which AI it uses,
 * answered by the accounts themselves: one row each, with what moves it
 * forward beside the line that says where it stands. A phone signs no
 * account in itself, so a signed-out account says how to connect it where
 * the operator asks. While an account still asks something of the operator,
 * creating the bot is the quieter way on under them; once one is connected
 * or on its way, the big button creates the bot, which says hello when its
 * AI is ready.
 */
function ConnectStep({
  engine,
  name,
  failure,
  onCreate,
}: {
  readonly engine: EngineStatus | null;
  readonly name: string;
  readonly failure: Failure | null;
  readonly onCreate: () => void;
}) {
  const i18n = useI18n();
  const { t } = i18n;
  const ai = useMobileAiConnect(engine);
  const connected = aiAccounts.find((account) => ai.accounts[account].state._tag === "ready");
  const text = connectStepText(engine, connected ?? null, name, i18n);
  const out = aiOutage(engine) !== null;
  // Creating the bot leads once an account is connected or on its way.
  const leads =
    out ||
    aiAccounts.some((account) => {
      const { state, queued } = ai.accounts[account];
      return aiOnItsWay(state, queued);
    });
  const createWaits = text.createWaits !== null;
  const under = text.createWaits ?? (leads ? text.later : null);
  return (
    <StepFrame
      actions={
        <>
          <FailureLine failure={failure} name={name} />
          {leads ? (
            <BigButton
              label={t("onboarding.create", { name })}
              onPress={onCreate}
              disabled={createWaits}
            />
          ) : (
            <Button
              variant="quiet"
              label={t("onboarding.connect.createLater", { name })}
              disabled={createWaits}
              onPress={onCreate}
            />
          )}
          {under !== null && (
            <Text className="text-center text-sm text-muted-foreground">{under}</Text>
          )}
        </>
      }
    >
      <StepTitle>{text.title}</StepTitle>
      {/* Live: the step says when an account connects, without moving on by itself. */}
      <Text accessibilityLiveRegion="polite" className="text-center text-lg text-muted-foreground">
        {text.body}
      </Text>
      {!out && <AiConnect ai={ai} />}
      {text.details.length > 0 && (
        <AiDetails>
          {text.details.map((detail) => (
            <Text key={detail} selectable className="text-xs text-muted-foreground">
              {detail}
            </Text>
          ))}
        </AiDetails>
      )}
    </StepFrame>
  );
}

/**
 * The bot arriving. Until the server has created it, only the bot above says
 * something is happening; then its light swells, its name pops in, and a line
 * says whether it is saying hello or waits for a model.
 */
function Arrival({
  engine,
  name,
  created,
}: {
  readonly engine: EngineStatus | null;
  readonly name: string;
  readonly created: boolean;
}) {
  const { t } = useI18n();
  const ready =
    engine !== null && engine.state._tag === "ready" && providerGate(engine)._tag === "ready";
  if (!created) return <StepFrame actions={null}>{null}</StepFrame>;
  return (
    <StepFrame actions={null}>
      <View className="mt-6 items-center gap-2">
        <Animated.View entering={popIn(stage.nameDelay)}>
          <StepTitle size="display">{t("onboarding.arrival.title", { name })}</StepTitle>
        </Animated.View>
        <Animated.Text
          entering={settleIn(springs.soft).delay(stage.lineDelay)}
          exiting={fadeOut}
          accessibilityLiveRegion="polite"
          className="text-center text-lg text-muted-foreground"
        >
          {ready ? t("onboarding.arrival.hello") : t("onboarding.arrival.waiting", { name })}
        </Animated.Text>
      </View>
    </StepFrame>
  );
}
