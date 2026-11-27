// SPDX-License-Identifier: AGPL-3.0-or-later
import { runByDesktopApp } from "@j3-bots/client-runtime";
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
  useJ3Client,
  useServerUpdate,
} from "@j3-bots/client-runtime/react";
import {
  type AiAccountText,
  aiAccountText,
  aiActionLabel,
  type AiTone,
} from "@j3-bots/client-runtime/wording";
import type { EngineStatus, ProviderId } from "@j3-bots/contracts";
import { Check, ChevronDown, ChevronRight, ExternalLink } from "lucide-react-native";
import { type ReactNode, useEffect, useState } from "react";
import { Linking, View } from "react-native";
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from "react-native-reanimated";
import { useI18n } from "../i18n.ts";
import { useReducedMotion } from "../motion.ts";
import { usePresentation } from "../presentation.tsx";
import { PressScale } from "../press.tsx";
import { Text } from "../text.tsx";
import { Button } from "../ui.tsx";
import { CommandLine } from "./CommandLine.tsx";
import { Icon } from "./Icon.tsx";

// Connecting an AI, as every screen of the app draws it: the first run's
// step, Settings, and a conversation whose bot waits for one. Each account is
// one row whose status line carries the one thing that moves it forward
// (docs/decisions/0085-signing-in-is-one-row-and-the-browser-opens-by-itself.md).
// A phone never runs the server, so an account signs in elsewhere: in the
// desktop app that runs it, or with a command on the server's machine.

/** The accounts, and what this app knows of each, as one screen connects them. */
export interface MobileAiConnect extends AiConnectModel {
  readonly engine: EngineStatus | null;
}

const noSignIns = new Map<ProviderId, never>();

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
function useAiText(ai: MobileAiConnect, account: AiAccountModel): AiAccountText {
  return aiAccountText(
    account.account,
    account.state,
    { engine: ai.engine, place: ai.place, signIn: undefined, queued: account.queued },
    usePresentation(),
  );
}

/** What breathes while something is under way; still under reduced motion. */
function Breathing({ on, children }: { readonly on: boolean; readonly children: ReactNode }) {
  const reduced = useReducedMotion();
  const opacity = useSharedValue(1);
  useEffect(() => {
    opacity.set(on && !reduced ? withRepeat(withTiming(0.35, { duration: 800 }), -1, true) : 1);
  }, [on, reduced, opacity]);
  const style = useAnimatedStyle(() => ({ opacity: opacity.get() }));
  return <Animated.View style={style}>{children}</Animated.View>;
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
function PageLink({ href, label }: { readonly href: string; readonly label: string }) {
  return (
    <PressScale
      accessibilityRole="link"
      accessibilityLabel={label}
      onPress={() => void Linking.openURL(href)}
      className="min-h-11 flex-row items-center gap-1.5 self-start"
    >
      <Icon icon={ExternalLink} color="accent-muted-foreground" size={14} />
      <Text className="text-xs text-muted-foreground underline">{label}</Text>
    </PressScale>
  );
}

/**
 * One AI account, as one row: its name, and under it the line that says
 * where it stands, with the one thing that moves it forward right beside
 * that line: How to connect while it is not connected, Try again after
 * something went wrong. What the operator reads only when they need it sits
 * under the row: how far a download is, where to sign in, and the details,
 * folded. `children`, as the version it runs, shows only once it is
 * connected. `stale` is a state reported before a disconnection: said,
 * muted, with nothing to press.
 */
function AiAccountRow({
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
  const i18n = useI18n();
  const { t } = i18n;
  const model = ai.accounts[account];
  const text = useAiText(ai, model);
  const [howOpen, setHowOpen] = useState(false);
  const { state, action } = model;
  const { name, maker, product } = aiAccountNames[account];
  // A signed-out account says where it signs in only when asked.
  const elsewhere = ai.place !== "here" && state._tag === "sign-in" && state.failed === null;
  const progress = progressOf(model);
  const stoppable = state._tag === "getting";
  const trailing = stale ? null : state._tag === "ready" ? (
    <Icon icon={Check} color="accent-success" size={20} />
  ) : action !== null ? (
    <Button
      variant={state._tag === "missing" && !state.canGet ? "secondary" : "primary"}
      label={aiActionLabel(action, account, i18n)}
      held={model.asking === "asking"}
      onPress={model.act}
    />
  ) : state._tag === "signing-in" || model.queued ? (
    <Button variant="quiet" label={t("ai.cancel")} onPress={model.cancel} />
  ) : elsewhere ? (
    <Button
      variant="secondary"
      label={t("ai.howToConnect")}
      expanded={howOpen}
      onPress={() => setHowOpen((now) => !now)}
    />
  ) : null;
  return (
    <View className="gap-2 rounded-lg border border-border bg-surface px-3 py-3">
      <View className="min-h-11 flex-row items-center gap-3">
        <View className="flex-1 gap-0.5">
          <View className="flex-row flex-wrap items-baseline gap-x-2">
            <Text className="text-sm font-semibold text-foreground">{name}</Text>
            <Text className="text-xs text-muted-foreground">{t("ai.by", { maker })}</Text>
          </View>
          <Text
            accessibilityLiveRegion="polite"
            className={`text-sm ${stale ? "text-muted-foreground" : toneClass[text.tone]}`}
          >
            {text.line}
          </Text>
        </View>
        {trailing}
      </View>
      {!stale && (
        <>
          {progress !== undefined && <Progress value={progress} label={text.line} />}
          {text.hint !== null && (!elsewhere || howOpen) && (
            <Text className="text-sm text-muted-foreground">{text.hint}</Text>
          )}
          {text.command !== null && howOpen && (
            <View className="w-full">
              <CommandLine command={text.command} />
            </View>
          )}
          {state._tag === "signing-in" && state.page !== null && (
            <PageLink href={state.page} label={t("ai.openPage")} />
          )}
          {state._tag === "missing" && state.page !== null && (
            <PageLink href={state.page} label={t("ai.howToInstall", { product })} />
          )}
          {model.asking === "failed" && (
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
                    held={model.asking === "asking"}
                    onPress={model.stopDownload}
                  />
                </View>
              )}
            </AiDetails>
          )}
          {state._tag === "ready" && children}
        </>
      )}
    </View>
  );
}

/**
 * Every AI account, one row each (`AiAccountRow`). `extra` is what each row
 * shows once connected, as its version in Settings.
 */
export function AiAccountList({
  ai,
  stale = false,
  extra,
}: {
  readonly ai: MobileAiConnect;
  readonly stale?: boolean;
  readonly extra?: (account: AiAccount) => ReactNode;
}) {
  const { t } = useI18n();
  return (
    <View accessibilityLabel={t("ai.choice.label")} className="w-full gap-2">
      {aiAccounts.map((account) => (
        <AiAccountRow key={account} ai={ai} account={account} stale={stale}>
          {extra?.(account)}
        </AiAccountRow>
      ))}
    </View>
  );
}

/**
 * Connecting an AI in one place, for a screen that is not Settings: the
 * accounts, one row each, and that it uses the plan the operator already
 * has. The first run's step and a conversation whose bot waits for its AI.
 */
export function AiConnect({ ai }: { readonly ai: MobileAiConnect }) {
  const { t } = useI18n();
  return (
    <View className="w-full gap-3">
      <AiAccountList ai={ai} />
      <Text className="text-center text-xs text-muted-foreground">{t("ai.plan")}</Text>
    </View>
  );
}
