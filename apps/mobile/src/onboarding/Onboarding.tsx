// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  defaultBotName,
  firstLooks,
  makingProgress,
  nextStep,
  type OnboardingStep,
  previousStep,
  providerGate,
  showsConnect,
} from "@j3-bots/client-runtime/presentation";
import { useEngineStatus, useJ3Client } from "@j3-bots/client-runtime/react";
import { connectStepText } from "@j3-bots/client-runtime/wording";
import {
  type AvatarChoice,
  type BotId,
  type EngineStatus,
  PROFILE_LIMITS,
} from "@j3-bots/contracts";
import type { BotColor } from "@j3-bots/design-tokens";
import * as ExpoCrypto from "expo-crypto";
import { ChevronLeft } from "lucide-react-native";
import { type ReactNode, useEffect, useState } from "react";
import {
  I18nManager,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
} from "react-native";
import Animated, {
  Easing,
  FadeIn,
  FadeInLeft,
  FadeInRight,
  FadeOut,
  FadeOutLeft,
  FadeOutRight,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withRepeat,
  withSequence,
  withSpring,
  withTiming,
  ZoomIn,
} from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { BotAvatar } from "../components/Avatar.tsx";
import { ProviderRow } from "../components/Engine.tsx";
import { Icon } from "../components/Icon.tsx";
import { SettingsEntry } from "../components/SettingsEntry.tsx";
import { useI18n } from "../i18n.ts";
import { useReducedMotion } from "../motion.ts";
import { useColor } from "../theme.ts";
import { CommandLine } from "../components/CommandLine.tsx";
import { BigButton, bigFieldClass, Cast, DISPLAY, StepTitle, TITLE } from "./parts.tsx";
import { pop, slide, soft } from "./springs.ts";

const idle = { _tag: "idle" } as const;

/** How long the arrival stays at least, so the bot is seen arriving before its conversation opens. */
const ARRIVAL_MS = 1600;

const after = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Each bot colour as an `accent-` utility, written out so Tailwind finds it. */
const botColor = {
  red: "accent-bot-red",
  orange: "accent-bot-orange",
  yellow: "accent-bot-yellow",
  green: "accent-bot-green",
  teal: "accent-bot-teal",
  blue: "accent-bot-blue",
  indigo: "accent-bot-indigo",
  violet: "accent-bot-violet",
  pink: "accent-bot-pink",
  gray: "accent-bot-gray",
} as const satisfies Record<BotColor, string>;

type Direction = "forward" | "back";

const enterFrom = (direction: Direction) => {
  const fromEnd = (direction === "forward") !== I18nManager.isRTL;
  return (fromEnd ? FadeInRight : FadeInLeft)
    .springify()
    .mass(slide.mass)
    .stiffness(slide.stiffness)
    .damping(slide.damping);
};

const leaveTo = (direction: Direction) => {
  const toStart = (direction === "forward") !== I18nManager.isRTL;
  return (toStart ? FadeOutLeft : FadeOutRight).duration(160);
};

/**
 * The first run, from the welcome to the first bot's arrival, one thing per
 * screen, as on the web: each screen slides in from the side it comes from,
 * Back returns to the one before, the bot being made stays above the screens
 * and answers what the operator does, and Continue always works. A provider
 * not connected yet never holds the bot back: it says hello once one is.
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
  const i18n = useI18n();
  const { t } = i18n;
  const insets = useSafeAreaInsets();
  const client = useJ3Client();
  const status = useEngineStatus();
  const engine = status._tag === "ready" ? status.value : null;
  const reduced = useReducedMotion();
  const [fallbackName] = useState(() => defaultBotName(ExpoCrypto.getRandomBytes(1)[0] ?? 0));
  const [name, setName] = useState(fallbackName);
  const [look, setLook] = useState<AvatarChoice>(firstLooks[0]);
  const [view, setView] = useState<{
    readonly step: OnboardingStep;
    readonly direction: Direction;
    readonly move: number;
  }>({ step: "welcome", direction: "forward", move: 0 });
  const [failed, setFailed] = useState(false);
  const [pokes, setPokes] = useState(0);
  const { step } = view;
  const botName = name.trim() === "" ? fallbackName : name.trim();
  const connect = showsConnect(engine, step);

  const go = (to: OnboardingStep, direction: Direction) => {
    setView((now) => ({ step: to, direction, move: now.move + 1 }));
    if (to !== "welcome") setPokes((count) => count + 1);
  };

  const create = () => {
    setFailed(false);
    const from = step;
    go("arrival", "forward");
    onCreating(true);
    const shown = after(reduced ? 0 : ARRIVAL_MS);
    void client.createBot({ name: botName, primary: true, avatar: look }).then((result) => {
      if (result._tag !== "done") {
        onCreating(false);
        setFailed(true);
        go(from, "back");
        return;
      }
      void shown.then(() => onArrived(result.value.id));
    });
  };

  const forward = () => {
    const to = nextStep(step, connect);
    if (to === null) return;
    if (to === "arrival") create();
    else go(to, "forward");
  };
  const back = () => {
    const to = previousStep(step, connect);
    if (to !== null) go(to, "back");
  };
  const canGoBack = previousStep(step, connect) !== null;
  const progress = makingProgress(step, connect);

  let screen: ReactNode;
  switch (step) {
    case "welcome":
      screen = <Welcome onStart={forward} />;
      break;
    case "name":
      screen = (
        <NameStep
          name={name}
          fallback={fallbackName}
          onName={(typed) => {
            setName(typed);
            setPokes((count) => count + 1);
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
            setLook(next);
            setPokes((count) => count + 1);
          }}
          ready={!connect}
          failed={failed}
          onContinue={forward}
        />
      );
      break;
    case "connect":
      screen = <ConnectStep engine={engine} name={botName} failed={failed} onCreate={create} />;
      break;
    case "arrival":
      screen = <Arrival engine={engine} name={botName} />;
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
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t("onboarding.back")}
              onPress={back}
              className="size-11 items-center justify-center rounded-md active:bg-muted"
            >
              <View style={I18nManager.isRTL ? { transform: [{ scaleX: -1 }] } : undefined}>
                <Icon icon={ChevronLeft} size={22} color="accent-muted-foreground" />
              </View>
            </Pressable>
          )}
        </View>
        <View className="flex-1 items-center">
          {progress !== null && <Progress {...progress} />}
        </View>
        {/* Settings is in reach before the first bot: devices, the server, signing out, the language. */}
        <View className="w-11">{step === "welcome" && <SettingsEntry />}</View>
      </View>
      {step !== "welcome" && (
        <Hero look={look} pokes={pokes} arrived={step === "arrival"} reduced={reduced} />
      )}
      <View className="flex-1 overflow-hidden">
        <Animated.View
          key={view.move}
          className="flex-1"
          {...(view.move === 0 ? {} : { entering: enterFrom(view.direction) })}
          exiting={leaveTo(view.direction)}
        >
          {screen}
        </Animated.View>
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
 * The bot being made, above the screens: it pops in, hops at every step and
 * every change, and grows when it arrives, with rings in its colour.
 */
function Hero({
  look,
  pokes,
  arrived,
  reduced,
}: {
  readonly look: AvatarChoice;
  readonly pokes: number;
  readonly arrived: boolean;
  readonly reduced: boolean;
}) {
  const hop = useSharedValue(0);
  const grow = useSharedValue(0);
  useEffect(() => {
    if (pokes === 0 || reduced) return;
    hop.set(withSequence(withTiming(-10, { duration: 70 }), withSpring(0, pop)));
  }, [pokes, reduced, hop]);
  useEffect(() => {
    grow.set(reduced ? (arrived ? 1 : 0) : withSpring(arrived ? 1 : 0, pop));
  }, [arrived, reduced, grow]);
  const style = useAnimatedStyle(() => ({
    transform: [{ translateY: hop.get() + grow.get() * 56 }, { scale: 1 + grow.get() * 0.5 }],
  }));
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      className="items-center pt-4 pb-6"
      style={{ zIndex: 1 }}
    >
      <Animated.View
        entering={ZoomIn.springify().mass(pop.mass).stiffness(pop.stiffness).damping(pop.damping)}
      >
        <Animated.View style={style}>
          {arrived &&
            !reduced &&
            [0, 1, 2].map((ring) => <Ring key={ring} index={ring} color={look.color} />)}
          <BotAvatar avatar={look} state={idle} size={96} />
        </Animated.View>
      </Animated.View>
    </View>
  );
}

function Ring({ index, color }: { readonly index: number; readonly color: BotColor }) {
  const borderColor = useColor(botColor[color]);
  const progress = useSharedValue(0);
  useEffect(() => {
    progress.set(
      withDelay(
        300 + index * 220,
        withTiming(1, { duration: 1400, easing: Easing.bezier(0.2, 0.8, 0.2, 1) }),
      ),
    );
  }, [index, progress]);
  const style = useAnimatedStyle(() => ({
    opacity: 0.55 * (1 - progress.get()),
    transform: [{ scale: 0.8 + 1.4 * progress.get() }],
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

function Welcome({ onStart }: { readonly onStart: () => void }) {
  const { t } = useI18n();
  return (
    <StepFrame actions={<BigButton label={t("onboarding.welcome.start")} onPress={onStart} />}>
      <View className="flex-1 items-center justify-center gap-6">
        <Cast />
        <View className="items-center gap-3">
          <StepTitle style={DISPLAY}>J3 Bots</StepTitle>
          <Text className="max-w-xs text-center text-lg text-muted-foreground">
            {t("onboarding.welcome.body")}
          </Text>
        </View>
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
        className={`${bigFieldClass} mt-2 w-full border-input text-center font-semibold focus:border-foreground`}
        style={{ fontSize: TITLE.fontSize }}
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
  failed,
  onContinue,
}: {
  readonly name: string;
  readonly look: AvatarChoice;
  readonly onLook: (look: AvatarChoice) => void;
  /** Whether the next step is the arrival, so Continue creates the bot. */
  readonly ready: boolean;
  readonly failed: boolean;
  readonly onContinue: () => void;
}) {
  const { t } = useI18n();
  return (
    <StepFrame
      actions={
        <>
          {ready && <Failure failed={failed} name={name} />}
          <BigButton
            label={ready ? t("onboarding.create", { name }) : t("onboarding.continue")}
            onPress={onContinue}
          />
        </>
      }
    >
      <StepTitle>{t("onboarding.look.title", { name })}</StepTitle>
      <View className="mt-2">
        <BotLookSlot look={look} onLook={onLook} />
      </View>
      <Text className="text-center text-sm text-muted-foreground">{t("onboarding.look.hint")}</Text>
    </StepFrame>
  );
}

/**
 * Where the first run lets the operator choose the first bot's look. It
 * offers today's avatars until the avatar picker takes its place, which takes
 * the same `look` and `onLook`.
 */
function BotLookSlot({
  look,
  onLook,
}: {
  readonly look: AvatarChoice;
  readonly onLook: (look: AvatarChoice) => void;
}) {
  const { t } = useI18n();
  return (
    <View
      accessibilityRole="radiogroup"
      accessibilityLabel={t("onboarding.look.options")}
      className="w-72 flex-row flex-wrap justify-center gap-2"
    >
      {firstLooks.map((option, index) => {
        const chosen = option.shape === look.shape && option.color === look.color;
        return (
          <Pressable
            key={`${option.shape}/${option.color}`}
            accessibilityRole="radio"
            accessibilityState={{ checked: chosen }}
            accessibilityLabel={t("onboarding.look.option", {
              number: index + 1,
              count: firstLooks.length,
            })}
            onPress={() => onLook(option)}
            className={`size-16 items-center justify-center rounded-lg border-2 bg-surface active:bg-muted ${chosen ? "border-foreground" : "border-transparent"}`}
          >
            <BotAvatar avatar={option} state={idle} size={40} ground="surface" />
          </Pressable>
        );
      })}
    </View>
  );
}

function Failure({ failed, name }: { readonly failed: boolean; readonly name: string }) {
  const { t } = useI18n();
  if (!failed) return null;
  return (
    <Text
      accessibilityLiveRegion="polite"
      role="alert"
      className="text-center text-sm text-blocked"
    >
      {t("onboarding.failed", { name })}
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
  failed,
  onCreate,
}: {
  readonly engine: EngineStatus | null;
  readonly name: string;
  readonly failed: boolean;
  readonly onCreate: () => void;
}) {
  const i18n = useI18n();
  const { t } = i18n;
  const text = connectStepText(engine, name, i18n);
  const unavailable =
    engine !== null && engine.state._tag === "ready" && providerGate(engine)._tag === "unavailable";
  return (
    <StepFrame
      actions={
        <>
          <Failure failed={failed} name={name} />
          <BigButton label={t("onboarding.create", { name })} onPress={onCreate} />
          {text.later !== null && (
            <Text className="text-center text-sm text-muted-foreground">{text.later}</Text>
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
      {unavailable && (
        <View className="w-full gap-1.5">
          {engine.providers.map((provider) => (
            <ProviderRow key={provider.id} provider={provider} />
          ))}
        </View>
      )}
      {/* Live: the step says when a provider connects, without moving on by itself. */}
      <View accessibilityLiveRegion="polite" className="flex-row items-center gap-2">
        <Pulse tone={text.status.tone} />
        <Text className={`text-sm font-medium ${toneClass[text.status.tone]}`}>
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

function Arrival({
  engine,
  name,
}: {
  readonly engine: EngineStatus | null;
  readonly name: string;
}) {
  const { t } = useI18n();
  const ready =
    engine !== null && engine.state._tag === "ready" && providerGate(engine)._tag === "ready";
  return (
    <StepFrame actions={null}>
      <View className="mt-24 items-center gap-2">
        <Animated.View
          entering={ZoomIn.springify()
            .mass(pop.mass)
            .stiffness(pop.stiffness)
            .damping(pop.damping)
            .delay(260)}
        >
          <StepTitle style={DISPLAY}>{t("onboarding.arrival.title", { name })}</StepTitle>
        </Animated.View>
        <Animated.Text
          entering={FadeIn.delay(420)}
          exiting={FadeOut}
          accessibilityLiveRegion="polite"
          className="text-center text-lg text-muted-foreground"
        >
          {ready ? t("onboarding.arrival.hello") : t("onboarding.arrival.waiting", { name })}
        </Animated.Text>
      </View>
    </StepFrame>
  );
}
