// SPDX-License-Identifier: AGPL-3.0-or-later
import type { J3Client } from "@j3-bots/client-runtime";
import {
  type BotItem,
  type Shared,
  sharedMessage,
  sharedTemplate,
} from "@j3-bots/client-runtime/presentation";
import { J3ClientProvider, useReadable } from "@j3-bots/client-runtime/react";
import { fileProblemText, messageProblemText } from "@j3-bots/client-runtime/wording";
import { type BotId, MAX_ATTACHMENTS_PER_MESSAGE } from "@j3-bots/contracts";
import { motion } from "@j3-bots/design-tokens";
import { useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, BackHandler, ScrollView, ToastAndroid, View } from "react-native";
import { KeyboardProvider, KeyboardStickyView } from "react-native-keyboard-controller";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { LiveBotAvatar } from "../components/avatar/mood.tsx";
import { TextField } from "../components/form.tsx";
import { SheetPanel } from "../components/Sheet.tsx";
import { I18nContext, useI18n } from "../i18n.ts";
import { useReducedMotion } from "../motion.ts";
import { session } from "../platform/platform.ts";
import { DeviceBlob } from "../platform/pick.ts";
import { i18nFor, usePreferences } from "../preferences.ts";
import { PressScale } from "../press.tsx";
import { openTemplateAt } from "../template/opened.ts";
import { Text } from "../text.tsx";
import { useColor } from "../theme.ts";
import { Body, Button } from "../ui.tsx";
import { sharedOf } from "./incoming.ts";
import { rememberSharedTo, lastSharedTo } from "./lastShared.ts";
import { type Incoming, shareSheet } from "./native.ts";
import { shareBots } from "./order.ts";

// The sheet another app's share opens (modules/share-sheet, ShareActivity):
// a panel over that app to pick a bot, add a line and send, which closes
// without the app ever coming forward. It runs in the app's own JavaScript,
// so it shares the session and the connection the app holds.

/** What the share holds, as read from the sheet's module. */
type Taken =
  | { readonly _tag: "reading" }
  | { readonly _tag: "unreadable"; readonly leftBehind: number }
  | {
      readonly _tag: "shared";
      readonly shared: Shared;
      readonly botId: string | null;
      readonly leftBehind: number;
      readonly beyond: number;
    };

const takenOf = (incoming: Incoming | null): Taken => {
  const shared = incoming === null ? null : sharedOf(incoming);
  const leftBehind = incoming?.unreadable ?? 0;
  return shared === null || incoming === null
    ? { _tag: "unreadable", leftBehind }
    : { _tag: "shared", shared, botId: incoming.botId, leftBehind, beyond: incoming.beyond };
};

/** Closes sheet `sheet` once its panel has left, as `Sheet` lets its window go. */
function useClosing(sheet: string): { readonly open: boolean; readonly close: () => void } {
  const reduced = useReducedMotion();
  const [open, setOpen] = useState(true);
  useEffect(() => {
    if (open) return;
    const timer = setTimeout(() => shareSheet?.close(sheet), reduced ? 0 : motion.state);
    return () => clearTimeout(timer);
  }, [open, reduced, sheet]);
  return useMemo(() => ({ open, close: () => setOpen(false) }), [open]);
}

/**
 * The share sheet's root, registered as `J3Share` (index.ts). `sheet` is the
 * key Android gave this sheet (ShareActivity), which every call names.
 */
export function ShareRoot({ sheet }: { readonly sheet?: unknown }) {
  const { language } = usePreferences();
  const i18n = useMemo(() => i18nFor(language), [language]);
  if (typeof sheet !== "string") return null;
  return (
    <I18nContext value={i18n}>
      <SafeAreaProvider>
        <KeyboardProvider>
          <ShareSheet sheet={sheet} />
        </KeyboardProvider>
      </SafeAreaProvider>
    </I18nContext>
  );
}

function ShareSheet({ sheet }: { readonly sheet: string }) {
  const { t } = useI18n();
  const { open, close } = useClosing(sheet);
  const [taken, setTaken] = useState<Taken>({ _tag: "reading" });
  const state = useReadable(session.state);

  useEffect(() => {
    if (shareSheet === null) return;
    let live = true;
    shareSheet
      .take(sheet)
      .then(async (incoming) => {
        const next = takenOf(incoming);
        // A template file shared on its own opens in the app, to make a bot from.
        const template = next._tag === "shared" ? sharedTemplate(next.shared) : null;
        if (template !== null) {
          await openTemplateAt(template.uri, template.size);
          shareSheet?.openApp(sheet, null);
          return;
        }
        if (live) setTaken(next);
      })
      .catch(() => {
        if (live) setTaken({ _tag: "unreadable", leftBehind: 0 });
      });
    return () => {
      live = false;
    };
  }, [sheet]);

  useEffect(() => {
    const subscription = BackHandler.addEventListener("hardwareBackPress", () => {
      close();
      return true;
    });
    return () => subscription.remove();
  }, [close]);

  const body = (() => {
    if (taken._tag === "reading" || state._tag === "starting") return <Waiting />;
    if (taken._tag === "unreadable") {
      return (
        <Notice
          text={t("share.unreadable")}
          leftBehind={taken.leftBehind}
          action={{ label: t("share.cancel"), onPress: close }}
        />
      );
    }
    if (state._tag !== "open") return <NotPaired sheet={sheet} />;
    return (
      <J3ClientProvider client={state.client}>
        <Sending
          sheet={sheet}
          client={state.client}
          shared={taken.shared}
          through={taken.botId}
          leftBehind={taken.leftBehind}
          beyond={taken.beyond}
          close={close}
        />
      </J3ClientProvider>
    );
  })();

  return (
    <KeyboardStickyView className="flex-1">
      <SheetPanel open={open} title={t("share.title")} onClose={close}>
        {body}
      </SheetPanel>
    </KeyboardStickyView>
  );
}

function Waiting() {
  const { t } = useI18n();
  const color = useColor("accent-muted-foreground");
  return (
    <View className="flex-row items-center gap-3 py-4" accessibilityLiveRegion="polite">
      <ActivityIndicator color={color} />
      <Body>{t("share.loading")}</Body>
    </View>
  );
}

function Notice(props: {
  readonly text: string;
  readonly leftBehind?: number;
  readonly action: { readonly label: string; readonly onPress: () => void };
}) {
  const { plural } = useI18n();
  const leftBehind = props.leftBehind ?? 0;
  return (
    <View className="gap-4 py-2">
      <Body>{props.text}</Body>
      {leftBehind > 0 && <Body>{plural("share.leftBehind", leftBehind)}</Body>}
      <Button variant="primary" label={props.action.label} onPress={props.action.onPress} />
    </View>
  );
}

function NotPaired({ sheet }: { readonly sheet: string }) {
  const { t } = useI18n();
  return (
    <Notice
      text={t("share.notPaired")}
      action={{ label: t("share.openApp"), onPress: () => shareSheet?.openApp(sheet, null) }}
    />
  );
}

/**
 * Where sending stands. While its files upload, Stop ends it; once the
 * message is handed to the outbox it goes on its own, and only waiting for
 * the server's answer is left.
 */
type Send =
  | { readonly _tag: "editing"; readonly problem: string | null }
  | { readonly _tag: "uploading"; readonly sent: number; readonly total: number }
  | { readonly _tag: "handed" };

function Sending(props: {
  readonly sheet: string;
  readonly client: J3Client;
  readonly shared: Shared;
  readonly through: string | null;
  readonly leftBehind: number;
  readonly beyond: number;
  readonly close: () => void;
}) {
  const i18n = useI18n();
  const { t, plural } = i18n;
  const roster = useReadable(props.client.roster);
  const connection = useReadable(props.client.connection);
  const bots = useMemo(
    () => (roster._tag === "ready" ? shareBots(roster.value, lastSharedTo()) : []),
    [roster],
  );
  const [picked, setPicked] = useState<BotId | null>(null);
  const [line, setLine] = useState("");
  const [send, setSend] = useState<Send>({ _tag: "editing", problem: null });
  const stopping = useRef<AbortController | null>(null);
  useEffect(() => () => stopping.current?.abort(), []);

  if (connection._tag === "unpaired") return <NotPaired sheet={props.sheet} />;
  if (roster._tag !== "ready") return <Waiting />;
  if (bots.length === 0) {
    return (
      <Notice
        text={t("share.noBots")}
        action={{ label: t("share.cancel"), onPress: props.close }}
      />
    );
  }
  // The bot picked, else the one the share came through by Direct Share, else
  // the one offered first. A bot asked for that is no longer there is never
  // swapped for another: the operator picks again.
  const asked = picked ?? props.through;
  const bot =
    asked === null ? (bots[0] ?? null) : (bots.find((item) => item.bot.id === asked) ?? null);
  const message = sharedMessage(props.shared, line);

  const start = (bot: BotItem) => {
    const name = bot.bot.profile.name;
    const controller = new AbortController();
    stopping.current = controller;
    setSend({ _tag: "uploading", sent: 0, total: 0 });
    void props.client
      .sendWithFiles(
        {
          target: { _tag: "conversation", botId: bot.bot.id },
          text: message.text,
          files: message.uploads.map((file) => ({
            name: file.name,
            body: new DeviceBlob(
              file.uri,
              file.mediaType === "" ? undefined : file.mediaType,
              file.size,
            ),
          })),
          onProgress: (sent, total) => setSend({ _tag: "uploading", sent, total }),
          onSending: () => setSend({ _tag: "handed" }),
        },
        controller.signal,
      )
      .then((result) => {
        stopping.current = null;
        switch (result._tag) {
          case "done":
            rememberSharedTo(bot.bot.id);
            void shareSheet?.reportShared(bot.bot.id);
            ToastAndroid.show(t("share.sent", { name }), ToastAndroid.SHORT);
            props.close();
            return;
          case "stopped":
            setSend({ _tag: "editing", problem: null });
            return;
          case "invalid":
            setSend({ _tag: "editing", problem: messageProblemText(result.problem, i18n) });
            return;
          case "refused": {
            const file = message.uploads[result.index];
            setSend({
              _tag: "editing",
              problem:
                file === undefined
                  ? t("share.failed")
                  : t("composer.file.failed", {
                      name: file.name,
                      reason: fileProblemText(result.problem, i18n),
                    }),
            });
            return;
          }
          case "failed":
            setSend({
              _tag: "editing",
              problem:
                result.failure._tag === "refused" && result.failure.error._tag === "NotFound"
                  ? t("share.gone", { name })
                  : t("share.failed"),
            });
            return;
        }
      });
  };

  const sending = send._tag !== "editing";
  const percent =
    send._tag === "uploading" && send.total > 0
      ? new Intl.NumberFormat(i18n.locale, { style: "percent" }).format(send.sent / send.total)
      : null;
  const nothing = message.text === "" && message.uploads.length === 0;

  return (
    <View className="gap-4">
      <Summary shared={props.shared} />
      <BotChoice bots={bots} picked={bot} onPick={setPicked} disabled={sending} />
      <TextField
        label={t("share.line")}
        placeholder={t("share.linePlaceholder")}
        value={line}
        onChange={setLine}
        readOnly={sending}
        multiline
      />
      {message.leftOut.map(({ file, problem }) => (
        <Body key={file.uri}>
          {t("composer.file.failed", { name: file.name, reason: fileProblemText(problem, i18n) })}
        </Body>
      ))}
      {props.leftBehind > 0 && <Body>{plural("share.leftBehind", props.leftBehind)}</Body>}
      {props.beyond > 0 && (
        <Body>{plural("share.beyond", props.beyond, { most: MAX_ATTACHMENTS_PER_MESSAGE })}</Body>
      )}
      {send._tag === "editing" && send.problem !== null && (
        <Text accessibilityLiveRegion="polite" role="alert" className="text-sm text-blocked">
          {send.problem}
        </Text>
      )}
      {sending && (
        <View accessibilityLiveRegion="polite" className="gap-1">
          <Body>
            {percent === null ? t("share.sending") : t("share.sendingPercent", { percent })}
          </Body>
          {connection._tag !== "connected" && <Body>{t("share.unreachable")}</Body>}
        </View>
      )}
      <View className="flex-row gap-2">
        {send._tag === "uploading" ? (
          <Button label={t("share.stop")} onPress={() => stopping.current?.abort()} grow />
        ) : send._tag === "handed" ? null : (
          <>
            <Button label={t("share.cancel")} onPress={props.close} grow />
            <Button
              variant="primary"
              label={
                bot === null ? t("share.pickBot") : t("share.send", { name: bot.bot.profile.name })
              }
              onPress={() => {
                if (bot !== null) start(bot);
              }}
              disabled={nothing || bot === null}
              grow
            />
          </>
        )}
      </View>
    </View>
  );
}

/** What is being shared, in a line: the start of its text, or how many files. */
function Summary({ shared }: { readonly shared: Shared }) {
  const { plural } = useI18n();
  const said = shared.title ?? shared.url ?? shared.text;
  return (
    <View className="gap-1">
      {said !== null && (
        <Text numberOfLines={2} className="text-sm text-foreground">
          {said}
        </Text>
      )}
      {shared.files.length > 0 && (
        <Text className="text-sm text-muted-foreground">
          {plural("share.files", shared.files.length)}
        </Text>
      )}
    </View>
  );
}

/** The bots to send to, as a row of faces with their names, one picked or none. */
function BotChoice(props: {
  readonly bots: ReadonlyArray<BotItem>;
  readonly picked: BotItem | null;
  readonly onPick: (botId: BotId) => void;
  readonly disabled: boolean;
}) {
  const { t } = useI18n();
  return (
    <View className="gap-2">
      <Text className="text-sm text-foreground">{t("share.bots")}</Text>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerClassName="gap-2"
        accessibilityRole="radiogroup"
      >
        {props.bots.map((item) => {
          const selected = item.bot.id === props.picked?.bot.id;
          return (
            <PressScale
              key={item.bot.id}
              accessibilityRole="radio"
              accessibilityLabel={item.bot.profile.name}
              accessibilityState={{ selected, disabled: props.disabled }}
              disabled={props.disabled}
              onPress={() => props.onPick(item.bot.id)}
              className={`w-20 items-center gap-1 rounded-md border px-1 py-2 ${selected ? "border-foreground bg-muted" : "border-transparent"}`}
            >
              <LiveBotAvatar
                bot={item.bot}
                unread={item.unread}
                size={44}
                ground={selected ? "muted" : "surface"}
              />
              <Text numberOfLines={1} className="text-xs text-foreground">
                {item.bot.profile.name}
              </Text>
            </PressScale>
          );
        })}
      </ScrollView>
    </View>
  );
}
