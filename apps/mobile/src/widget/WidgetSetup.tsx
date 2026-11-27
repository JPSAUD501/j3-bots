// SPDX-License-Identifier: AGPL-3.0-or-later
import type { J3Client } from "@j3-bots/client-runtime";
import { J3ClientProvider, useReadable, useRoutines } from "@j3-bots/client-runtime/react";
import type { BotId } from "@j3-bots/contracts";
import { motion } from "@j3-bots/design-tokens";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ActivityIndicator, BackHandler, View } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { LiveBotAvatar } from "../components/avatar/mood.tsx";
import { ChoiceRow } from "../components/form.tsx";
import { SheetPanel } from "../components/Sheet.tsx";
import { I18nContext, useI18n } from "../i18n.ts";
import { useReducedMotion } from "../motion.ts";
import { session } from "../platform/platform.ts";
import { i18nFor, usePreferences } from "../preferences.ts";
import { shareBots } from "../share/order.ts";
import { useColor } from "../theme.ts";
import { Body, Button } from "../ui.tsx";
import { refreshWidgets } from "./feed.ts";
import { homeWidget, type WidgetTarget } from "./native.ts";

// Where a widget is given what it shows (modules/home-widget,
// WidgetSetupActivity): a panel over the home screen to pick a bot, or a bot
// and then one of its routines.

/** The longest the setup waits for the widget to be written before it closes, in ms. */
const WRITE_WAIT = 3000;

/** Where the setup is. */
type Step =
  | { readonly _tag: "kind" }
  | { readonly _tag: "bot"; readonly for: WidgetTarget["kind"] }
  | { readonly _tag: "routine"; readonly botId: BotId; readonly name: string };

/** The setup's root, registered as `J3WidgetSetup` (index.ts). */
export function WidgetSetupRoot() {
  const { language } = usePreferences();
  const i18n = useMemo(() => i18nFor(language), [language]);
  return (
    <I18nContext value={i18n}>
      <SafeAreaProvider>
        <WidgetSetup />
      </SafeAreaProvider>
    </I18nContext>
  );
}

function WidgetSetup() {
  const { t } = useI18n();
  const reduced = useReducedMotion();
  const state = useReadable(session.state);
  const [open, setOpen] = useState(true);
  const [step, setStep] = useState<Step>({ _tag: "kind" });
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) return;
    const timer = setTimeout(() => homeWidget?.close(), reduced ? 0 : motion.state);
    return () => clearTimeout(timer);
  }, [open, reduced]);

  const back = useCallback(() => {
    if (saving) return;
    if (step._tag === "routine") setStep({ _tag: "bot", for: "routine" });
    else if (step._tag === "bot") setStep({ _tag: "kind" });
    else setOpen(false);
  }, [step, saving]);
  useEffect(() => {
    const subscription = BackHandler.addEventListener("hardwareBackPress", () => {
      back();
      return true;
    });
    return () => subscription.remove();
  }, [back]);

  const choose = (target: WidgetTarget) => {
    if (homeWidget === null || saving) return;
    const widgets = homeWidget;
    setSaving(true);
    void widgets
      .choose(target)
      .then(() =>
        Promise.race([
          refreshWidgets(),
          new Promise<void>((resolve) => setTimeout(resolve, WRITE_WAIT)),
        ]),
      )
      .catch(() => undefined)
      .finally(() => setOpen(false));
  };

  const title =
    step._tag === "kind"
      ? t("widget.setup.title")
      : step._tag === "routine"
        ? t("widget.setup.pickRoutine")
        : t("widget.setup.pickBot");

  const body = (() => {
    if (state._tag === "starting") return <Waiting />;
    if (state._tag !== "open") return <NotPaired />;
    return (
      <J3ClientProvider client={state.client}>
        <Choice client={state.client} step={step} go={setStep} choose={choose} saving={saving} />
      </J3ClientProvider>
    );
  })();

  return (
    <SheetPanel
      open={open}
      title={title}
      onClose={() => setOpen(false)}
      footer={
        step._tag === "kind" ? undefined : (
          <View className="px-5 pb-4">
            <Button label={t("widget.setup.back")} onPress={back} held={saving} />
          </View>
        )
      }
    >
      {body}
    </SheetPanel>
  );
}

function Waiting() {
  const color = useColor("accent-muted-foreground");
  return (
    <View className="items-center py-6">
      <ActivityIndicator color={color} />
    </View>
  );
}

function NotPaired() {
  const { t } = useI18n();
  return (
    <View className="gap-4 py-2">
      <Body>{t("widget.notPaired")}</Body>
      <Button
        variant="primary"
        label={t("share.openApp")}
        onPress={() => homeWidget?.openApp(null)}
      />
    </View>
  );
}

function Choice(props: {
  readonly client: J3Client;
  readonly step: Step;
  readonly go: (step: Step) => void;
  readonly choose: (target: WidgetTarget) => void;
  readonly saving: boolean;
}) {
  const { t } = useI18n();
  const roster = useReadable(props.client.roster);
  const connection = useReadable(props.client.connection);
  const bots = useMemo(
    () => (roster._tag === "ready" ? shareBots(roster.value, null) : []),
    [roster],
  );
  if (connection._tag === "unpaired") return <NotPaired />;
  const { step } = props;
  switch (step._tag) {
    case "kind":
      return (
        <View className="gap-2">
          <ChoiceRow
            kind="one"
            label={t("widget.setup.bot")}
            description={t("widget.setup.botHint")}
            selected={false}
            onPress={() => props.go({ _tag: "bot", for: "bot" })}
          />
          <ChoiceRow
            kind="one"
            label={t("widget.setup.routine")}
            description={t("widget.setup.routineHint")}
            selected={false}
            onPress={() => props.go({ _tag: "bot", for: "routine" })}
          />
        </View>
      );
    case "bot":
      if (roster._tag !== "ready") return <Waiting />;
      if (bots.length === 0) return <Body>{t("share.noBots")}</Body>;
      return (
        <View className="gap-2">
          {bots.map((item) => (
            <ChoiceRow
              key={item.bot.id}
              kind="one"
              label={item.bot.profile.name}
              selected={false}
              unavailable={props.saving}
              leading={
                <LiveBotAvatar bot={item.bot} unread={item.unread} size={28} ground="surface" />
              }
              onPress={() =>
                step.for === "bot"
                  ? props.choose({ kind: "bot", botId: item.bot.id })
                  : props.go({ _tag: "routine", botId: item.bot.id, name: item.bot.profile.name })
              }
            />
          ))}
        </View>
      );
    case "routine":
      return (
        <Routines botId={step.botId} name={step.name} choose={props.choose} saving={props.saving} />
      );
  }
}

function Routines(props: {
  readonly botId: BotId;
  readonly name: string;
  readonly choose: (target: WidgetTarget) => void;
  readonly saving: boolean;
}) {
  const { t } = useI18n();
  const routines = useRoutines(props.botId);
  if (routines === null || routines._tag === "loading") return <Waiting />;
  if (routines._tag === "not-found" || routines.value.length === 0) {
    return <Body>{t("details.noRoutines", { name: props.name })}</Body>;
  }
  return (
    <View className="gap-2">
      {routines.value.map((routine) => (
        <ChoiceRow
          key={routine.id}
          kind="one"
          label={routine.name}
          selected={false}
          unavailable={props.saving}
          onPress={() =>
            props.choose({ kind: "routine", botId: props.botId, routineId: routine.id })
          }
        />
      ))}
    </View>
  );
}
