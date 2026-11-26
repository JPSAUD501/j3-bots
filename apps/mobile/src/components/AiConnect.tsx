// SPDX-License-Identifier: AGPL-3.0-or-later
import { runByDesktopApp } from "@j3-bots/client-runtime";
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
  useJ3Client,
  useServerUpdate,
} from "@j3-bots/client-runtime/react";
import {
  type AiAccountText,
  aiAccountText,
  aiActionLabel,
  type AiTone,
  signInStepLabel,
} from "@j3-bots/client-runtime/wording";
import type { EngineStatus } from "@j3-bots/contracts";
import {
  Check,
  ChevronDown,
  ChevronRight,
  CornerDownLeft,
  type LucideIcon,
  Monitor,
  Terminal,
  UserRoundCheck,
} from "lucide-react-native";
import { type ReactNode, useEffect, useState } from "react";
import { Linking, View } from "react-native";
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from "react-native-reanimated";
import { useI18n } from "../i18n.ts";
import { popIn, useReducedMotion } from "../motion.ts";
import { usePresentation } from "../presentation.tsx";
import { PressScale } from "../press.tsx";
import { Text } from "../text.tsx";
import { Button } from "../ui.tsx";
import { CommandLine } from "./CommandLine.tsx";
import { Icon } from "./Icon.tsx";

// Connecting an AI, as every screen of the app draws it: the first run's
// step, Settings, and a conversation whose bot waits for one
// (docs/decisions/0066-connecting-an-ai-is-picking-the-account-you-have.md).
// A phone never runs the server, so an account signs in elsewhere: in the
// desktop app that runs it, or with a command on the server's machine.

/** The accounts, and what this app knows of each, as one screen connects them. */
export interface MobileAiConnect extends AiConnectModel {
  readonly engine: EngineStatus | null;
}

const noSignIns = new Map<AiAccount, never>();

/** The accounts as this screen connects them. */
export function useMobileAiConnect(engine: EngineStatus | null): MobileAiConnect {
  const client = useJ3Client();
  const place: AiPlace = runByDesktopApp(useServerUpdate()) ? "desktop-app" : "server";
  const took = (request: ReturnType<typeof client.recheckProvider>) =>
    request.then((result) => result._tag === "done");
  const model = useAiConnect({
    facts: { engine, locations: null, signIns: noSignIns },
    place,
    intents: {
      signIn: null,
      cancelSignIn: null,
      download: (account) => took(client.installHarness(account)),
      cancelDownload: (account) => took(client.cancelHarnessInstall(account)),
      recheck: (providerId) => took(client.recheckProvider(providerId)),
    },
  });
  return { ...model, engine };
}

const toneClass = {
  ready: "text-success",
  waiting: "text-foreground",
  blocked: "text-blocked",
  muted: "text-muted-foreground",
} as const satisfies Record<AiTone, string>;

/** An account's words, for the state it is in on this screen. */
export function useAiText(ai: MobileAiConnect, account: AiAccountModel): AiAccountText {
  return aiAccountText(
    account.account,
    account.state,
    { engine: ai.engine, place: ai.place, signIn: undefined, queued: account.queued },
    usePresentation(),
  );
}

/**
 * The question the first screen asks: which AI the operator has. One large
 * button each, with a mark on the one already connected.
 */
export function AiChoice({ ai }: { readonly ai: MobileAiConnect }) {
  const { t } = useI18n();
  return (
    <View className="w-full gap-3">
      <View accessibilityLabel={t("ai.choice.label")} className="w-full gap-2">
        {aiAccounts.map((account) => {
          const { name, maker, product } = aiAccountNames[account];
          const connected = ai.accounts[account].state._tag === "ready";
          const subtitle = `${t("ai.by", { maker })} · ${product}`;
          return (
            <PressScale
              key={account}
              accessibilityRole="button"
              accessibilityLabel={`${name}, ${subtitle}`}
              accessibilityState={{ selected: connected }}
              onPress={() => ai.open(account)}
              className="min-h-18 flex-row items-center gap-3 rounded-lg border border-input bg-surface px-4 py-3"
            >
              <View className="flex-1">
                <Text className="text-lg font-semibold text-foreground">{name}</Text>
                <Text className="text-sm text-muted-foreground">{subtitle}</Text>
              </View>
              {connected ? (
                <Icon icon={Check} color="accent-success" size={20} />
              ) : (
                <Icon icon={ChevronRight} color="accent-muted-foreground" size={20} />
              )}
            </PressScale>
          );
        })}
      </View>
      <Text className="text-center text-xs text-muted-foreground">{t("ai.plan")}</Text>
    </View>
  );
}

/** What breathes while it is the step under way; still under reduced motion. */
function Breathing({ on, children }: { readonly on: boolean; readonly children: ReactNode }) {
  const reduced = useReducedMotion();
  const opacity = useSharedValue(1);
  useEffect(() => {
    opacity.set(on && !reduced ? withRepeat(withTiming(0.35, { duration: 800 }), -1, true) : 1);
  }, [on, reduced, opacity]);
  const style = useAnimatedStyle(() => ({ opacity: opacity.get() }));
  return <Animated.View style={style}>{children}</Animated.View>;
}

const firstStepIcon = { "desktop-app": Monitor, server: Terminal, here: Monitor } as const;

/**
 * The sign-in, drawn: where it starts, the operator signs in, and they come
 * back. The step under way stands out and breathes; those behind it are
 * checked. Before a sign-in starts, the three are only what is to come.
 */
function SignInSteps({
  account,
  at,
  place,
}: {
  readonly account: AiAccount;
  readonly at: SignInStep | "done" | null;
  readonly place: AiPlace;
}) {
  const i18n = useI18n();
  const reached = at === null ? -1 : at === "done" ? signInSteps.length : signInSteps.indexOf(at);
  const icons: Record<SignInStep, LucideIcon> = {
    page: firstStepIcon[place],
    "sign-in": UserRoundCheck,
    back: CornerDownLeft,
  };
  return (
    <View accessibilityLabel={i18n.t("ai.steps.label")} className="w-full flex-row items-start">
      {signInSteps.map((step, index) => {
        const current = index === reached;
        const done = index < reached;
        return (
          <View key={step} className="flex-1 items-center gap-2">
            {index > 0 && (
              <View
                className={`absolute top-5.5 right-1/2 h-px w-full ${index <= reached ? "bg-foreground" : "bg-border"}`}
              />
            )}
            <View
              className={`size-11 items-center justify-center rounded-pill border bg-background ${
                current ? "border-foreground" : done ? "border-success" : "border-border"
              }`}
            >
              <Breathing on={current}>
                <Icon
                  icon={done ? Check : icons[step]}
                  color={
                    current
                      ? "accent-foreground"
                      : done
                        ? "accent-success"
                        : "accent-muted-foreground"
                  }
                  size={20}
                />
              </Breathing>
            </View>
            <Text
              className={`px-1 text-center text-xs ${current ? "font-medium text-foreground" : "text-muted-foreground"}`}
            >
              {signInStepLabel(step, account, place, i18n)}
            </Text>
          </View>
        );
      })}
    </View>
  );
}

/**
 * How far something is, quietly: a thin bar that fills as it goes, or, when
 * how far is not known, one that breathes. `label` is what a screen reader
 * hears it is.
 */
function Progress({ value, label }: { readonly value: number | null; readonly label: string }) {
  const reduced = useReducedMotion();
  const filled = useSharedValue(value ?? 1);
  useEffect(() => {
    const to = value === null ? 1 : Math.max(0.04, value);
    filled.set(reduced ? to : withTiming(to, { duration: 320 }));
  }, [value, reduced, filled]);
  const style = useAnimatedStyle(() => ({ width: `${filled.get() * 100}%` }));
  return (
    <View
      accessibilityRole="progressbar"
      accessibilityLabel={label}
      accessibilityValue={
        value === null ? { text: label } : { min: 0, max: 100, now: Math.round(value * 100) }
      }
      className="h-1.5 w-full overflow-hidden rounded-pill bg-muted"
    >
      <Breathing on={value === null}>
        <Animated.View className="h-full rounded-pill bg-foreground" style={style} />
      </Breathing>
    </View>
  );
}

/** What was said, as it was said, folded away under "Details" until the operator asks. */
export function AiDetails({ children }: { readonly children: ReactNode }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  return (
    <View className="w-full gap-1.5">
      <PressScale
        accessibilityRole="button"
        accessibilityLabel={t("ai.details")}
        accessibilityState={{ expanded: open }}
        onPress={() => setOpen((now) => !now)}
        className="min-h-11 flex-row items-center gap-1.5 self-start"
      >
        <Icon icon={open ? ChevronDown : ChevronRight} color="accent-muted-foreground" size={14} />
        <Text className="text-xs text-muted-foreground">{t("ai.details")}</Text>
      </PressScale>
      {open && <View className="gap-1.5">{children}</View>}
    </View>
  );
}

/** How far a state is, for the bar; `undefined` for a state that shows none. */
const progressOf = ({ state }: AiAccountModel): number | null | undefined => {
  switch (state._tag) {
    case "getting":
    case "preparing":
      return state.progress;
    case "checking":
    case "finishing":
      return null;
    case "ready":
    case "signing-in":
    case "sign-in":
    case "missing":
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
  readonly ai: MobileAiConnect;
  readonly account: AiAccountModel;
  readonly said?: "line" | "hint" | null;
  readonly button?: boolean;
  /**
   * `start` in a list, as Settings', where the account is one of several and
   * the sign-in is drawn only once it is under way; centered where the
   * account has the screen.
   */
  readonly align?: "center" | "start";
}) {
  const i18n = useI18n();
  const { t } = i18n;
  const text = useAiText(ai, account);
  const { state, action } = account;
  const { product } = aiAccountNames[account.account];
  const progress = progressOf(account);
  const centered = align === "center";
  // The sign-in is drawn while it is under way, and before it, where the account has the screen.
  const drawn =
    state._tag === "signing-in" ||
    state._tag === "finishing" ||
    (centered && state._tag === "sign-in" && state.failed === null);
  const page = state._tag === "missing" ? state.page : null;
  const stoppable = state._tag === "getting";
  const words = centered ? "text-center" : "";
  return (
    <View className={`w-full gap-3 ${centered ? "items-center" : "items-start"}`}>
      {state._tag === "ready" && centered && (
        <Animated.View
          entering={popIn()}
          className="size-14 items-center justify-center rounded-pill bg-success"
        >
          <Icon icon={Check} color="accent-background" size={28} />
        </Animated.View>
      )}
      {said === null && (
        <Text
          accessibilityLiveRegion="polite"
          className={`text-sm ${words} ${toneClass[text.tone]}`}
        >
          {text.line}
        </Text>
      )}
      {drawn && <SignInSteps account={account.account} at={signInStepAt(state)} place={ai.place} />}
      {progress !== undefined && <Progress value={progress} label={text.line} />}
      {text.hint !== null && said !== "hint" && (
        <Text className={`text-sm text-muted-foreground ${words}`}>{text.hint}</Text>
      )}
      {text.command !== null && (
        <View className="w-full">
          <CommandLine command={text.command} />
        </View>
      )}
      {page !== null && (
        <Button
          variant="secondary"
          label={t("ai.howToInstall", { product })}
          onPress={() => void Linking.openURL(page)}
        />
      )}
      {button && action !== null && (
        <View className="w-full">
          <Button
            variant={page === null ? "primary" : "secondary"}
            label={aiActionLabel(action, account.account, i18n)}
            held={account.asking === "asking"}
            onPress={account.act}
          />
        </View>
      )}
      {account.asking === "failed" && (
        <Text accessibilityRole="alert" className="text-xs text-blocked">
          {t("ai.requestFailed")}
        </Text>
      )}
      {(text.details.length > 0 || stoppable) && (
        <AiDetails>
          {text.details.map((detail) => (
            <Text key={detail} selectable className="text-xs text-muted-foreground">
              {detail}
            </Text>
          ))}
          {stoppable && (
            <View className="flex-row">
              <Button
                variant="quiet"
                label={t("ai.stopDownload")}
                held={account.asking === "asking"}
                onPress={account.stopDownload}
              />
            </View>
          )}
        </AiDetails>
      )}
    </View>
  );
}

/** The way from one account to the other: a wrong turn has an obvious way back. */
export function OtherAccount({
  ai,
  account,
}: {
  readonly ai: MobileAiConnect;
  readonly account: AiAccount;
}) {
  const { t } = useI18n();
  const other = otherAiAccount(account);
  return (
    <Button
      variant="quiet"
      label={t("ai.other", { account: aiAccountNames[other].name })}
      onPress={() => ai.open(other)}
    />
  );
}

/**
 * Connecting an AI, in one place: the question, which one the operator has,
 * then that account alone, with the other one press away. For a screen that
 * is not the first run's step, as a conversation whose bot waits for its AI.
 */
export function AiConnect({ engine }: { readonly engine: EngineStatus | null }) {
  const ai = useMobileAiConnect(engine);
  const { opened } = ai;
  if (opened === null) return <AiChoice ai={ai} />;
  return (
    <View className="w-full items-center gap-3">
      <Text className="text-base font-semibold text-foreground">
        {aiAccountNames[opened.account].name}
      </Text>
      <AiAccountPanel ai={ai} account={opened} />
      <OtherAccount ai={ai} account={opened.account} />
    </View>
  );
}

/**
 * One account as Settings lists it: its name and maker, then the account
 * whole (`AiAccountPanel`), with `children` after it, as its version.
 * `stale` is a state reported before a disconnection: said, muted, with
 * nothing to press.
 */
export function AiAccountCard({
  ai,
  account,
  stale = false,
  children,
}: {
  readonly ai: MobileAiConnect;
  readonly account: AiAccount;
  readonly stale?: boolean;
  readonly children?: ReactNode;
}) {
  const { t } = useI18n();
  const { name, maker } = aiAccountNames[account];
  const text = useAiText(ai, ai.accounts[account]);
  return (
    <View className="gap-3 rounded-md border border-border px-3 py-3">
      <View className="flex-row flex-wrap items-baseline gap-x-2">
        <Text className="text-sm font-semibold text-foreground">{name}</Text>
        <Text className="text-xs text-muted-foreground">{t("ai.by", { maker })}</Text>
      </View>
      {stale ? (
        <Text className="text-sm text-muted-foreground">{text.line}</Text>
      ) : (
        <>
          <AiAccountPanel ai={ai} account={ai.accounts[account]} align="start" />
          {children}
        </>
      )}
    </View>
  );
}
