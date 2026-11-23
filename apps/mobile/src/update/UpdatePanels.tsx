// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Readable, UpdateResult } from "@j3-bots/client-runtime";
import {
  useJ3Client,
  useReadable,
  useServerUpdate,
  useServerUpdateEnded,
} from "@j3-bots/client-runtime/react";
import {
  type ServerUpdateLine,
  serverUpdateLine,
  startRefusalText,
  type UpdateTone,
  updateResultLine,
} from "@j3-bots/client-runtime/wording";
import type { ReceivedUpdateStatus, ReleaseVersion, UpdateChannel } from "@j3-bots/contracts";
import Constants from "expo-constants";
import { useEffect, useState } from "react";
import { AppState, Linking, View } from "react-native";
import { ConnectCommand } from "../components/Engine.tsx";
import { Problem, Quiet, Segmented } from "../components/form.tsx";
import { useConfirm } from "../confirm.tsx";
import { useI18n } from "../i18n.ts";
import { Text } from "../text.tsx";
import { Button } from "../ui.tsx";
import { type AppUpdateState, appUpdate } from "./appUpdate.ts";
import { type PhoneUpdateAction, phoneUpdateLine } from "./phoneWording.ts";

// How updates read on the phone: the server's, which the phone can start, and
// the app's own. Settings shows both with their channels; the screen for a
// server on another protocol shows the one that brings the two together.

const TONE: Record<UpdateTone, string> = {
  quiet: "text-foreground",
  working: "text-foreground",
  offer: "text-foreground font-medium",
  blocked: "text-blocked",
};

/** One update line: what it says, in its tone, then what happens next. */
export function ToneLine(props: {
  readonly text: string;
  readonly tone: UpdateTone;
  readonly hint: string | null;
  readonly command?: string | null;
}) {
  return (
    <View className="gap-1">
      <Text
        accessibilityLiveRegion={props.tone === "working" ? "polite" : "none"}
        className={`text-sm tabular-nums ${TONE[props.tone]}`}
      >
        {props.text}
      </Text>
      {props.hint !== null && <Quiet>{props.hint}</Quiet>}
      {props.command != null && <ConnectCommand command={props.command} />}
    </View>
  );
}

/** Opens a release's notes, which only ever live on an https page. */
const openNotes = (url: string) => {
  if (url.startsWith("https://")) void Linking.openURL(url);
};

const lastStatus = (view: ReturnType<typeof useServerUpdate>): ReceivedUpdateStatus | null => {
  switch (view._tag) {
    case "status":
      return view.status;
    case "unreachable":
      return view.last;
    case "restarting":
    case "lost":
      return view.last;
    case "unread":
    case "unsupported":
      return null;
  }
};

/**
 * The result worth showing: the one this phone saw end, until it is put
 * away, else the server's last one while the server still runs the version
 * it left, which is when a rollback or a failure is still news.
 */
const resultToShow = (
  ended: UpdateResult | null,
  status: ReceivedUpdateStatus | null,
): UpdateResult | null => {
  if (ended !== null) return ended;
  const last = status?.lastResult ?? null;
  if (last === null || last.outcome === "done") return null;
  return status?.current.version === last.from ? last : null;
};

/**
 * Starts the server's update with one tap. The first try leaves the bots'
 * work alone; a server with work running says so, and only then does the
 * operator choose to stop it. Any other refusal is said where the button is.
 */
function useStartServerUpdate() {
  const i18n = useI18n();
  const { t } = i18n;
  const client = useJ3Client();
  const confirm = useConfirm();
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const start = async (version: ReleaseVersion, stopWork: boolean): Promise<void> => {
    setPending(true);
    setProblem(null);
    const result = await client.serverUpdate.start(version, stopWork);
    setPending(false);
    switch (result._tag) {
      case "started":
      case "unsupported":
        // The view says what started, or that the server updates on its machine.
        return;
      case "refused":
        if (result.reason === "work-running" && !stopWork) {
          confirm({
            title: t("serverUpdate.stopWork.title"),
            body: i18n.plural("serverUpdate.stopWork.body", result.runningBots ?? 1),
            cancel: t("serverUpdate.stopWork.cancel"),
            confirm: t("serverUpdate.stopWork.confirm"),
            onConfirm: () => void start(version, true),
          });
          return;
        }
        setProblem(startRefusalText(result.reason, i18n));
        return;
      case "unreachable":
      case "not-paired":
        setProblem(t("serverUpdate.notReached"));
        return;
    }
  };
  return { start, pending, problem };
}

/**
 * The server's updates: what it runs, what it is offered and the one tap
 * that takes it, how an update under way goes, and how the last one ended.
 * With `controls`, also the server's channel and a check of its feed now.
 * Opening it reads the status again.
 */
export function ServerUpdatePanel(props: { readonly controls: boolean }) {
  const i18n = useI18n();
  const { t } = i18n;
  const client = useJ3Client();
  const view = useServerUpdate();
  const ended = useServerUpdateEnded();
  const { start, pending, problem } = useStartServerUpdate();
  const [requestProblem, setRequestProblem] = useState<string | null>(null);
  const [requesting, setRequesting] = useState(false);
  useEffect(() => {
    client.serverUpdate.refresh();
  }, [client]);

  const status = lastStatus(view);
  const shown: ServerUpdateLine | null = serverUpdateLine(view, i18n);
  const result = resultToShow(ended, status);
  const resultLine = result === null ? null : updateResultLine(result, i18n);
  const channel = status?.channel;

  const request = async (send: () => Promise<string>) => {
    setRequesting(true);
    setRequestProblem(null);
    const answer = await send();
    setRequesting(false);
    if (answer === "unreachable" || answer === "not-paired") {
      setRequestProblem(t("serverUpdate.notReached"));
    }
  };

  return (
    <View className="gap-3">
      {status !== null && (
        <Text className="text-sm text-muted-foreground">
          {t("update.version", { version: status.current.version })}
        </Text>
      )}
      {resultLine !== null && (
        <ToneLine
          text={resultLine.text}
          tone={resultLine.tone}
          hint={resultLine.hint}
          command={resultLine.command}
        />
      )}
      {shown === null ? (
        <Quiet>{t("update.checking")}</Quiet>
      ) : (
        <ToneLine text={shown.text} tone={shown.tone} hint={shown.hint} command={shown.command} />
      )}
      {shown?.offer != null && (
        <View className="flex-row flex-wrap items-start gap-2">
          <Button
            variant="primary"
            label={t("serverUpdate.update")}
            held={pending}
            onPress={() => {
              if (shown.offer !== null) void start(shown.offer.version, false);
            }}
          />
          <Button
            label={t("serverUpdate.whatsNew")}
            onPress={() => {
              if (shown.offer !== null) openNotes(shown.offer.notesUrl);
            }}
          />
        </View>
      )}
      <Problem>{problem}</Problem>
      {props.controls && channel !== undefined && channel !== "unknown" && (
        <ChannelChoice
          value={channel}
          onChange={(next) => void request(() => client.serverUpdate.setChannel(next))}
        />
      )}
      {props.controls && view._tag !== "unsupported" && (
        <View className="items-start">
          <Button
            label={t("update.check")}
            held={requesting || shown?.tone === "working"}
            onPress={() => void request(client.serverUpdate.check)}
          />
        </View>
      )}
      <Problem>{requestProblem}</Problem>
    </View>
  );
}

/** Stable or nightly, and what nightly means once it is chosen. */
function ChannelChoice(props: {
  readonly value: UpdateChannel;
  readonly onChange: (channel: UpdateChannel) => void;
}) {
  const { t } = useI18n();
  return (
    <View className="gap-2">
      <Text className="text-sm text-foreground">{t("updateChannel.label")}</Text>
      <Segmented
        label={t("updateChannel.label")}
        value={props.value}
        options={[
          { value: "stable", label: t("updateChannel.stable") },
          { value: "nightly", label: t("updateChannel.nightly") },
        ]}
        onChange={props.onChange}
      />
      {props.value === "nightly" && <Quiet>{t("updateChannel.nightly.hint")}</Quiet>}
    </View>
  );
}

const NO_STATE: Readable<null> = { get: () => null, subscribe: () => () => undefined };
const STABLE: Readable<UpdateChannel> = {
  get: () => "stable",
  subscribe: () => () => undefined,
};

/** Where the app's own update stands, or null in a build that does not update itself. */
export const useAppUpdateState = (): AppUpdateState | null =>
  useReadable<AppUpdateState | null>(appUpdate?.state ?? NO_STATE);

/**
 * Checks for the app's update when the app starts and each time it comes
 * back, at most every six hours, and goes on with an install that waited for
 * the operator to allow it in Android's settings.
 */
export function useAppUpdateFollowing() {
  useEffect(() => {
    const update = appUpdate;
    if (update === null) return;
    void update.check(true);
    const subscription = AppState.addEventListener("change", (state) => {
      if (state !== "active") return;
      update.resume();
      void update.check(true);
    });
    return () => subscription.remove();
  }, []);
}

const act = (action: PhoneUpdateAction) => {
  const update = appUpdate;
  if (update === null) return;
  switch (action) {
    case "update":
    case "install":
    case "retry":
      void update.update();
      return;
    case "allow":
      update.allowInstalls();
      return;
    case "play":
      update.openPlay();
      return;
  }
};

const ACTION_LABEL = {
  update: "phoneUpdate.update",
  install: "phoneUpdate.install",
  allow: "phoneUpdate.permission.open",
  play: "phoneUpdate.openPlay",
  retry: "update.retry",
} as const;

/**
 * The app's own update: the version it runs, where its update stands, and
 * the one thing to do about it. With `controls`, also the phone's channel
 * and a check now.
 */
export function PhoneUpdatePanel(props: { readonly controls: boolean }) {
  const i18n = useI18n();
  const { t } = i18n;
  const state = useAppUpdateState();
  const channel = useReadable(appUpdate?.channel ?? STABLE);
  if (appUpdate === null || state === null) {
    const version = Constants.expoConfig?.version;
    return (
      <View className="gap-1">
        {version !== undefined && (
          <Text className="text-sm text-muted-foreground">{t("update.version", { version })}</Text>
        )}
        <Quiet>{t("update.unavailable")}</Quiet>
      </View>
    );
  }
  const update = appUpdate;
  const shown = phoneUpdateLine(state, i18n);
  const version = update.installed.versionName;
  const working = shown.tone === "working";
  return (
    <View className="gap-3">
      {version !== null && (
        <Text className="text-sm text-muted-foreground">{t("update.version", { version })}</Text>
      )}
      <ToneLine text={shown.text} tone={shown.tone} hint={shown.hint} />
      {(shown.action !== null || shown.notesUrl !== null) && (
        <View className="flex-row flex-wrap items-start gap-2">
          {shown.action !== null && (
            <Button
              variant="primary"
              label={t(ACTION_LABEL[shown.action])}
              onPress={() => {
                if (shown.action !== null) act(shown.action);
              }}
            />
          )}
          {shown.notesUrl !== null && (
            <Button
              label={t("serverUpdate.whatsNew")}
              onPress={() => {
                if (shown.notesUrl !== null) openNotes(shown.notesUrl);
              }}
            />
          )}
        </View>
      )}
      {props.controls && state._tag !== "play" && (
        <>
          <ChannelChoice value={channel} onChange={update.setChannel} />
          <View className="items-start">
            <Button label={t("update.check")} held={working} onPress={() => void update.check()} />
          </View>
        </>
      )}
    </View>
  );
}
