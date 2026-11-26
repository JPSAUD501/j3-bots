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
import { ChevronLeft } from "lucide-react-native";
import {
  type ComponentRef,
  type ReactNode,
  type Ref,
  useEffect,
  useEffectEvent,
  useId,
  useRef,
  useState,
} from "react";
import {
  BackHandler,
  I18nManager,
  KeyboardAvoidingView,
  Linking,
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
  withDelay,
  withRepeat,
  withSpring,
  withTiming,
} from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Svg, { Defs, LinearGradient, Rect, Stop } from "react-native-svg";
import { AvatarChoices } from "../components/avatar/AvatarPicker.tsx";
import { type AvatarHandle, BotAvatar } from "../components/avatar/BotAvatar.tsx";
import { ProviderRow } from "../components/Engine.tsx";
import { Icon } from "../components/Icon.tsx";
import { SettingsEntry } from "../components/SettingsEntry.tsx";
import { useI18n } from "../i18n.ts";
import { popIn, settleIn, useReducedMotion } from "../motion.ts";
import { useColor } from "../theme.ts";
import { CommandLine } from "../components/CommandLine.tsx";
import { useTint } from "../conversation/tint.ts";
import { PressScale } from "../press.tsx";
import { displaySpacing, Text, TextInput } from "../text.tsx";
import { type Box, boxFrom, sendOff, useSentOff } from "./handoff.tsx";
import { BigButton, bigFieldClass, Cast, type Lead, Pool, StepTitle } from "./parts.tsx";
import { clearProgress, readProgress, writeProgress } from "./progress.ts";

const pop = reanimatedSpring(springs.pop);
const soft = reanimatedSpring(springs.soft);
const slide = reanimatedSpring(springs.slide);
const easeOut = Easing.bezier(...easeOutCurve);

/** The bot above the steps, in px, and the room above and under it, which every step but the welcome leaves free; under it, its name. */
const HERO_SIZE = 96;
const HERO_ABOVE = 20;
const HERO_BELOW = 44;
const HERO_ROOM = HERO_ABOVE + HERO_SIZE + HERO_BELOW;
/**
 * Where the arrival's title starts under that room, below the farthest ring,
 * so no ring crosses it: the ring's radius, less how far the grown bot's
 * centre sits above the room's end, and a little space.
 */
const ARRIVAL_TITLE_TOP =
  (HERO_SIZE * (1 + stage.arrivalGrowth) * stage.rings.reach) / 2 -
  (HERO_SIZE / 2 + HERO_BELOW) +
  12;

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
 * stage as on the web: the cast comes down into its lights, the bot being
 * made is the cast's first bot, carried closer to its place above the steps
 * and back, and each step's lines arrive under it. There it answers what the
 * operator does with its own motion: it looks down at the name as it is typed
 * and wears it, takes each shape and color as it is picked, and once it exists
 * a light crosses the stage, it cheers, and it travels on into its
 * conversation (`sendOff`). Back returns to the step before, and Continue
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
  // Where the cast's first bot is, in the steps: set as the bot being made leaves it, which the welcome then
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

  // Kept as it goes, so putting the app away does not start the first run over.
  useEffect(() => {
    if (!created) writeProgress({ step, name: typed, look });
  }, [created, step, typed, look]);

  const go = (to: OnboardingStep) => {
    if (to === "connect") setConnectShown(true);
    setView((now) => ({ step: to, move: now.move + 1 }));
    // The bot being made takes each step with the operator.
    if (to !== "welcome") bot.current?.poke(to === "arrival" ? "hover" : "nod");
  };
  // Leaving the welcome, the bot being made first takes the cast's first bot's place, and once it
  // is laid out there the welcome goes (`lifted`): so the welcome leaves without it.
  const leaveWelcome = () => {
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
    void client.createBot({ name: botName, primary: true, avatar: look }).then((result) => {
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
          // Where the grown bot is drawn: its place, grown as it arrived.
          sendOff(result.value.id, look, {
            x: x + width / 2,
            y: y + HERO_ABOVE + HERO_SIZE / 2,
            width: HERO_SIZE * (1 + stage.arrivalGrowth),
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
    else if (step === "welcome") leaveWelcome();
    else go(to);
  };
  const back = () => {
    const to = previousStep(step, flow);
    if (to !== null) go(to);
  };
  const canGoBack = previousStep(step, flow) !== null;
  const progress = makingProgress(step, flow);

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
      screen = (
        <Welcome
          onStart={forward}
          leadRef={leadRef}
          lead={reduced ? "pops" : lifting ? "away" : view.move === 0 ? "pops" : "after"}
          first={view.move === 0}
        />
      );
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
      <View ref={stepsRef} className="flex-1 overflow-hidden">
        <Animated.View
          key={view.move}
          className="flex-1"
          style={{ paddingTop: step === "welcome" ? 0 : HERO_ROOM }}
          {...(view.move === 0 ? {} : { entering: reduced ? fadeIn : arrive })}
          exiting={reduced ? fadeOut : giveWay}
        >
          {screen}
        </Animated.View>
        {(step !== "welcome" || lifting) && (
          <Hero
            ref={heroRef}
            botRef={bot}
            look={look}
            name={step === "name" || step === "look" || step === "connect" ? botName : null}
            arrived={step === "arrival" && created}
            reduced={reduced}
            home={home}
            {...(lifting ? { onPlaced: lifted } : {})}
          />
        )}
        {step === "arrival" && created && !reduced && <Sweep />}
      </View>
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
 * it grows, with rings in its colour. Once sent off into its conversation, the
 * bot in flight stands for it. Under reduced motion it fades in and out and
 * keeps still.
 */
function Hero({
  look,
  name,
  arrived,
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
  // How large it is drawn: closer than the cast, and grown once it exists.
  const size = arrived ? 1 + stage.arrivalGrowth : stage.close;
  const scale = useSharedValue(1);
  useEffect(() => {
    scale.set(reduced ? size : withSpring(size, arrived ? pop : soft));
  }, [size, arrived, reduced, scale]);
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
          <Pool look={look} size={HERO_SIZE} delay={0} />
          {arrived &&
            !reduced &&
            Array.from({ length: stage.rings.count }, (_, ring) => (
              <Ring key={ring} index={ring} look={look} />
            ))}
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

/** The finale's light: a soft band that crosses the stage once, in the text's color so it shows on either theme. */
function Sweep() {
  const id = useId();
  const light = useColor("accent-foreground");
  const across = useSharedValue(0);
  useEffect(() => {
    across.set(withTiming(1, { duration: stage.sweep, easing: easeOut }));
  }, [across]);
  const style = useAnimatedStyle(() => ({
    left: `${-60 + 200 * across.get()}%`,
    transform: [{ skewX: "-18deg" }],
  }));
  return (
    <Animated.View
      pointerEvents="none"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      className="absolute inset-y-0 w-[45%]"
      style={[{ zIndex: 2 }, style]}
    >
      <Svg width="100%" height="100%" preserveAspectRatio="none">
        <Defs>
          <LinearGradient id={id} x1="0" y1="0" x2="1" y2="0">
            <Stop offset="0" stopColor={light} stopOpacity={0} />
            <Stop offset="0.5" stopColor={light} stopOpacity={0.12} />
            <Stop offset="1" stopColor={light} stopOpacity={0} />
          </LinearGradient>
        </Defs>
        <Rect width="100%" height="100%" fill={`url(#${id})`} />
      </Svg>
    </Animated.View>
  );
}

function Ring({ index, look }: { readonly index: number; readonly look: AvatarChoice }) {
  const borderColor = useTint(look).color;
  const progress = useSharedValue(0);
  useEffect(() => {
    progress.set(
      withDelay(
        springs.pop.duration / 2 + index * stage.rings.gap,
        withTiming(1, { duration: stage.rings.duration, easing: easeOut }),
      ),
    );
  }, [index, progress]);
  const style = useAnimatedStyle(() => ({
    opacity: 0.55 * (1 - progress.get()),
    transform: [{ scale: 0.8 + (stage.rings.reach - 0.8) * progress.get() }],
  }));
  return (
    <Animated.View
      className="absolute inset-0 rounded-full border-2"
      style={[{ borderColor }, style]}
    />
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
    <View className="flex-1 px-6 pb-6">
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
 * The first screen: the cast coming down onto the stage, what J3 Bots is, and
 * the way in, which is there from the first frame. The first time it shows,
 * its words arrive as the cast does.
 */
function Welcome({
  onStart,
  lead,
  leadRef,
  first,
}: {
  readonly onStart: () => void;
  readonly lead: Lead;
  readonly leadRef: Ref<ComponentRef<typeof View>>;
  readonly first: boolean;
}) {
  const { t } = useI18n();
  const rise = (order: number) =>
    first ? { entering: settleIn(springs.soft).delay(stage.focus.gap * order) } : {};
  return (
    <StepFrame actions={<BigButton label={t("onboarding.welcome.start")} onPress={onStart} />}>
      <View className="flex-1 items-center justify-center gap-6">
        <Cast lead={lead} leadRef={leadRef} />
        <Animated.View className="items-center gap-3" {...rise(1)}>
          <StepTitle size="display">J3 Bots</StepTitle>
          <Text className="max-w-xs text-center text-lg text-muted-foreground">
            {t("onboarding.welcome.body")}
          </Text>
        </Animated.View>
      </View>
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

const toneClass = {
  waiting: "text-waiting",
  ready: "text-success",
  muted: "text-muted-foreground",
} as const;

const dotClass = {
  waiting: "bg-waiting",
  ready: "bg-success",
  muted: "bg-muted-foreground",
} as const;

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
  const text = connectStepText(engine, name, i18n);
  const { login } = text;
  // Each provider that cannot run, with why and what fixes it: all of them
  // when none can, and beside the command, those that connecting would not fix.
  const gate = engine !== null && engine.state._tag === "ready" ? providerGate(engine) : null;
  const listed =
    engine === null || gate === null
      ? []
      : gate._tag === "unavailable"
        ? engine.providers
        : gate._tag === "connect"
          ? engine.providers.filter(cannotRun)
          : [];
  return (
    <StepFrame
      actions={
        <>
          <FailureLine failure={failure} name={name} />
          <BigButton
            label={t("onboarding.create", { name })}
            onPress={onCreate}
            disabled={text.createWaits !== null}
          />
          {(text.createWaits ?? text.later) !== null && (
            <Text className="text-center text-sm text-muted-foreground">
              {text.createWaits ?? text.later}
            </Text>
          )}
        </>
      }
    >
      <StepTitle>{text.title}</StepTitle>
      <Text className="text-center text-lg text-muted-foreground">{text.body}</Text>
      {text.command !== null && (
        <View className="mt-1 w-full">
          <CommandLine command={text.command} />
        </View>
      )}
      {login !== null && (
        <Text className="text-center text-sm text-muted-foreground">
          {login.text}{" "}
          <Text
            accessibilityRole="link"
            onPress={() => void Linking.openURL(login.url)}
            className="font-medium text-foreground underline"
          >
            {login.link}
          </Text>
        </Text>
      )}
      {listed.length > 0 && (
        <View className="w-full gap-1.5">
          {listed.map((provider) => (
            <ProviderRow key={provider.id} provider={provider} />
          ))}
        </View>
      )}
      {/* Live: the step says when a provider connects, without moving on by itself. */}
      <View accessibilityLiveRegion="polite" className="flex-row items-center gap-2">
        <Pulse tone={text.status.tone} />
        <Text className={`text-sm font-medium tabular-nums ${toneClass[text.status.tone]}`}>
          {text.status.text}
        </Text>
      </View>
    </StepFrame>
  );
}

function Pulse({ tone }: { readonly tone: "waiting" | "ready" | "muted" }) {
  const reduced = useReducedMotion();
  const opacity = useSharedValue(1);
  useEffect(() => {
    if (tone !== "waiting" || reduced) {
      opacity.set(1);
      return;
    }
    opacity.set(withRepeat(withTiming(0.35, { duration: 800 }), -1, true));
  }, [tone, reduced, opacity]);
  const style = useAnimatedStyle(() => ({ opacity: opacity.get() }));
  return <Animated.View className={`size-2 rounded-full ${dotClass[tone]}`} style={style} />;
}

/**
 * The bot arriving. Until the server has created it, only the bot above says
 * something is happening; then it grows, its name pops in, and a line says
 * whether it is saying hello or waits for a model.
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
      <View className="items-center gap-2" style={{ marginTop: ARRIVAL_TITLE_TOP }}>
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
