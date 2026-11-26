// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  offeredRelease,
  serverOffer,
  type UpdatePlan,
  type UpdatePromptEntry,
  type UpdatePromptInput,
  type UpdateRun,
  updatePromptEntry,
  updatePromptShown,
} from "@j3-bots/client-runtime";
import { useJ3Client, useReadable, useServerUpdate } from "@j3-bots/client-runtime/react";
import { serverFailureLine, serverUpdateLine } from "@j3-bots/client-runtime/wording";
import { motion, reanimatedSpring, springs } from "@j3-bots/design-tokens";
import { type ComponentRef, type ReactNode, useEffect, useRef, useState } from "react";
import { AccessibilityInfo, Linking, Modal, ScrollView, View } from "react-native";
import Animated, { FadeIn, FadeOut, ZoomIn } from "react-native-reanimated";
import { useI18n } from "../i18n.ts";
import { Text, displaySpacing } from "../text.tsx";
import { OVERLAY_ELEVATION } from "../theme.ts";
import { Button } from "../ui.tsx";
import { appUpdate } from "./appUpdate.ts";
import { phoneUpdateLine } from "./phoneWording.ts";
import { ToneLine, useAppUpdateState } from "./UpdatePanels.tsx";
import { clientSideOf, updatePromptOf } from "./updatePrompt.ts";

// The update prompt on the phone: one dialog in front of the app when a
// newer release is ready for the server or for the app, with the version,
// what it brings and "Update now", which updates the server first and the
// app after it (decision 0051). It shows each part as it goes, why one did
// not go through, and what the operator can do then. "Later" puts it away
// for a day; the line over the roster brings it back.

const pop = reanimatedSpring(springs.pop);

/** When the next "Later" runs out, so the prompt is looked at again then. */
const useNow = (until: number | null): number => {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (until === null || until <= now) return;
    // From the time now, not the last render's: "Later" is often pressed long after it.
    const wait = Math.max(0, Math.min(until - Date.now(), 2 ** 31 - 1));
    const timer = setTimeout(() => setNow(Date.now()), wait);
    return () => clearTimeout(timer);
  }, [until, now]);
  return now;
};

/**
 * The prompt for this client: its runner's state, what is on offer, and
 * whether the dialog is in front. `blocked` when another screen already
 * asks in front, as the one for a server this app cannot talk to.
 */
function useUpdatePrompt(blocked: boolean) {
  const client = useJ3Client();
  const prompt = updatePromptOf(client);
  const state = useReadable(prompt.state);
  const view = useServerUpdate();
  const pairing = useReadable(client.pairing);
  const phone = useAppUpdateState();
  const side = clientSideOf(phone);
  const now = useNow(state.snooze?.until ?? null);
  const input: UpdatePromptInput = {
    paired: pairing !== null,
    blocked,
    server: serverOffer(view),
    app: side.app,
    now,
  };
  return {
    prompt,
    state,
    input,
    side,
    phone,
    view,
    open: updatePromptShown(state, input),
    entry: updatePromptEntry(state, input),
  };
}

/** The dialog, over whatever screen it is placed on. */
export function UpdatePromptModal({ blocked }: { readonly blocked: boolean }) {
  const { prompt, state, open } = useUpdatePrompt(blocked);
  const dismiss = () => {
    switch (state.run._tag) {
      case "server":
      case "client":
      case "done":
        return prompt.hide();
      default:
        return prompt.later();
    }
  };
  return (
    <Modal
      visible={open}
      transparent
      statusBarTranslucent
      animationType="none"
      onRequestClose={dismiss}
    >
      <View className="flex-1 items-center justify-center px-6">
        <Animated.View
          entering={FadeIn.duration(motion.slow)}
          className="absolute inset-0 bg-scrim"
        />
        <Animated.View
          accessibilityViewIsModal
          entering={ZoomIn.springify()
            .mass(pop.mass)
            .stiffness(pop.stiffness)
            .damping(pop.damping)
            .withInitialValues({ transform: [{ scale: 0.94 }] })}
          exiting={FadeOut.duration(motion.state)}
          className="max-h-[85%] w-full max-w-sm rounded-xl border border-border bg-surface"
          style={{ elevation: OVERLAY_ELEVATION }}
        >
          <ScrollView contentContainerClassName="gap-3 p-6">
            <Body blocked={blocked} run={state.run} />
          </ScrollView>
        </Animated.View>
      </View>
    </Modal>
  );
}

/** The title, which a screen reader moves to whenever it changes, as each part comes in. */
function Title({ children }: { readonly children: string }) {
  return <TitleText key={children}>{children}</TitleText>;
}

function TitleText({ children }: { readonly children: string }) {
  const title = useRef<ComponentRef<typeof Text>>(null);
  useEffect(() => {
    if (title.current !== null) AccessibilityInfo.sendAccessibilityEvent(title.current, "focus");
  }, []);
  return (
    <Text
      ref={title}
      accessibilityRole="header"
      face="display"
      className="text-2xl text-foreground"
      style={{ letterSpacing: displaySpacing(24) }}
    >
      {children}
    </Text>
  );
}

function Sentence({ children }: { readonly children: ReactNode }) {
  return <Text className="text-base text-muted-foreground">{children}</Text>;
}

function Actions({ children }: { readonly children: ReactNode }) {
  return <View className="mt-2 flex-row flex-wrap justify-end gap-2">{children}</View>;
}

function Body({ blocked, run }: { readonly blocked: boolean; readonly run: UpdateRun }) {
  const i18n = useI18n();
  const { t, plural } = i18n;
  const { prompt, input, side, phone, view } = useUpdatePrompt(blocked);
  const appLine = phone === null ? null : phoneUpdateLine(phone, i18n);
  switch (run._tag) {
    case "idle": {
      const server = offeredRelease(input.server);
      const release = server ?? input.app;
      if (release === null) return null;
      return (
        <>
          <Title>
            {server !== null
              ? t("updatePrompt.title", { version: server.version })
              : t("updatePrompt.titleApp", { version: release.version })}
          </Title>
          <Sentence>
            {server === null
              ? t("updatePrompt.plan.app")
              : side.follow === "install"
                ? t("updatePrompt.plan.serverThenApp", { version: server.version })
                : t("updatePrompt.plan.server")}
          </Sentence>
          <View className="gap-2 rounded-lg bg-muted p-3">
            {release.highlights.length > 0 && (
              <>
                <Text className="text-xs font-medium text-muted-foreground">
                  {t("updatePrompt.whatsNew")}
                </Text>
                {release.highlights.map((highlight) => (
                  <Text key={highlight} className="text-sm text-foreground">
                    {`• ${highlight}`}
                  </Text>
                ))}
              </>
            )}
            <Text
              accessibilityRole="link"
              onPress={() => {
                if (release.notesUrl.startsWith("https://")) void Linking.openURL(release.notesUrl);
              }}
              className="text-sm text-foreground underline"
            >
              {t("updatePrompt.notes")}
            </Text>
          </View>
          <Actions>
            <Button label={t("updatePrompt.later")} onPress={prompt.later} />
            <Button variant="primary" label={t("updatePrompt.update")} onPress={prompt.updateNow} />
          </Actions>
          <Text className="text-xs text-muted-foreground">{t("updatePrompt.later.hint")}</Text>
        </>
      );
    }
    case "server":
    case "client": {
      const version = run.plan.server?.version ?? run.plan.app?.version ?? null;
      return (
        <>
          <Title>
            {version === null
              ? t("updatePrompt.entry.running")
              : t("updatePrompt.updating", { version })}
          </Title>
          {run.plan.server !== null && (
            <Step
              label={t("updatePrompt.step.server")}
              state={run._tag === "server" ? "active" : "done"}
              line={serverUpdateLine(view, i18n)?.text ?? t("updatePrompt.starting")}
            />
          )}
          {run.plan.client !== null && (
            <Step
              label={t("updatePrompt.step.app")}
              state={run._tag === "client" ? "active" : "pending"}
              line={
                run._tag === "server" ? t("updatePrompt.step.waiting") : (appLine?.text ?? null)
              }
            />
          )}
          {run._tag === "client" && appLine?.action === "allow" && appUpdate !== null && (
            <View className="items-start">
              <Button
                variant="primary"
                label={t("phoneUpdate.permission.open")}
                onPress={appUpdate.allowInstalls}
              />
            </View>
          )}
          <Actions>
            <Button label={t("updatePrompt.hide")} onPress={prompt.hide} />
          </Actions>
        </>
      );
    }
    case "work-running":
      return (
        <>
          <Title>{t("updatePrompt.work.title")}</Title>
          <Sentence>
            {`${plural(run.side === "server" ? "updatePrompt.work.server" : "updatePrompt.work.app", run.runningBots)} ${t("updatePrompt.work.hint")}`}
          </Sentence>
          <Actions>
            <Button label={t("updatePrompt.later")} onPress={prompt.later} />
            <Button
              variant="primary"
              label={t("updatePrompt.work.stop")}
              onPress={prompt.stopWork}
            />
          </Actions>
        </>
      );
    case "server-failed": {
      const line = serverFailureLine(run.failure, i18n);
      return (
        <>
          <Title>{t("updatePrompt.serverFailed.title")}</Title>
          <ToneLine text={line.text} tone={line.tone} hint={line.hint} command={line.command} />
          <Sentence>{t("updatePrompt.serverFailed.hint")}</Sentence>
          <Actions>
            <Button label={t("updatePrompt.later")} onPress={prompt.later} />
            <Button variant="primary" label={t("updatePrompt.retry")} onPress={prompt.retry} />
          </Actions>
        </>
      );
    }
    case "client-failed":
      return (
        <>
          <Title>{t("updatePrompt.appFailed.title", { version: versionOf(run.plan) })}</Title>
          {appLine !== null && <ToneLine text={appLine.text} tone={appLine.tone} hint={null} />}
          <Sentence>{t("updatePrompt.appFailed.hint")}</Sentence>
          <Actions>
            <Button label={t("updatePrompt.later")} onPress={prompt.later} />
            <Button variant="primary" label={t("updatePrompt.retry")} onPress={prompt.retry} />
          </Actions>
        </>
      );
    case "done":
      return (
        <>
          <Title>{t("updatePrompt.done.title", { version: versionOf(run.plan) })}</Title>
          {run.plan.client !== null && <Sentence>{t("updatePrompt.done.body")}</Sentence>}
          <Actions>
            <Button variant="primary" label={t("updatePrompt.close")} onPress={prompt.hide} />
          </Actions>
        </>
      );
  }
}

const versionOf = (plan: UpdatePlan): string => plan.server?.version ?? plan.app?.version ?? "";

/** One part of the sequence: its name, where it stands, and how it goes while it runs. */
function Step(props: {
  readonly label: string;
  readonly state: "pending" | "active" | "done";
  readonly line: string | null;
}) {
  const { t } = useI18n();
  return (
    <View className="flex-row items-start gap-3">
      <View
        className={`mt-1 size-4 rounded-pill ${
          props.state === "done"
            ? "bg-foreground"
            : props.state === "active"
              ? "bg-accent"
              : "border border-border"
        }`}
      />
      <View className="flex-1 gap-0.5">
        <Text
          className={`text-base ${props.state === "pending" ? "text-muted-foreground" : "text-foreground"}`}
        >
          {props.label}
        </Text>
        <Text
          accessibilityLiveRegion={props.state === "active" ? "polite" : "none"}
          className="text-sm text-muted-foreground"
        >
          {props.state === "done" ? t("updatePrompt.step.done") : (props.line ?? "")}
        </Text>
      </View>
    </View>
  );
}

/** The quiet way back to the prompt: what waits behind it, for the line over the roster. */
export const useUpdatePromptEntry = (): {
  readonly entry: UpdatePromptEntry | null;
  readonly reopen: () => void;
} => {
  const { prompt, entry } = useUpdatePrompt(false);
  return { entry, reopen: prompt.reopen };
};
