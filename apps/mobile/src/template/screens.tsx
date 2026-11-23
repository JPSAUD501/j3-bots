// SPDX-License-Identifier: AGPL-3.0-or-later
import { type IntentResult, refusedWith, type TemplateDraft } from "@j3-bots/client-runtime";
import { templateStart } from "@j3-bots/client-runtime/presentation";
import { useConnection, useEngineStatus, useJ3Client } from "@j3-bots/client-runtime/react";
import { permissionModeText, templateReadText } from "@j3-bots/client-runtime/wording";
import { type BotTemplate, PermissionMode } from "@j3-bots/contracts";
import type { NavigationContainerRefWithCurrent } from "@react-navigation/native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { Cpu, ShieldAlert } from "lucide-react-native";
import { type ReactNode, useEffect, useLayoutEffect, useState } from "react";
import { ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ChoiceRow, Problem, Quiet, Section } from "../components/form.tsx";
import { Icon } from "../components/Icon.tsx";
import { useI18n } from "../i18n.ts";
import { type Screens, useReplaceWithConversation } from "../navigation.tsx";
import { useRosterItem } from "../screens/rosterItem.ts";
import { Text } from "../text.tsx";
import { useSay } from "../toast.tsx";
import { Button } from "../ui.tsx";
import { useOpenedTemplate } from "./opened.ts";
import { sendTemplate } from "./share.ts";
import { TemplatePreview } from "./TemplatePreview.tsx";

/** A template's screen: what it shows, scrolling, over a bar that keeps its actions in reach. */
function TemplateScreen({
  children,
  bar,
}: {
  readonly children: ReactNode;
  readonly bar: ReactNode;
}) {
  const insets = useSafeAreaInsets();
  return (
    <View className="flex-1 bg-background">
      <ScrollView className="flex-1" contentContainerClassName="pb-6">
        {children}
      </ScrollView>
      <View
        className="gap-2 border-t border-border bg-background px-4 pt-3"
        style={{ paddingBottom: insets.bottom + 12 }}
      >
        {bar}
      </View>
    </View>
  );
}

/** A sentence under the screen's title, before the template. */
function Lead({ children }: { readonly children: string }) {
  return <Text className="px-5 pt-4 text-sm text-muted-foreground">{children}</Text>;
}

type Load =
  | { readonly _tag: "loading" }
  | { readonly _tag: "failed" }
  | { readonly _tag: "ready"; readonly template: BotTemplate };

const LOADING: Load = { _tag: "loading" };

const loaded = (result: IntentResult<BotTemplate>): Load =>
  result._tag === "done" ? { _tag: "ready", template: result.value } : { _tag: "failed" };

/**
 * Sharing a bot as a template: the file is read from the server, shown in
 * full with what stays here, and handed to the system's share sheet on Share.
 */
export function ShareTemplateScreen({
  navigation,
  route,
}: NativeStackScreenProps<Screens, "shareTemplate">) {
  const { t } = useI18n();
  const client = useJ3Client();
  const say = useSay();
  const { botId } = route.params;
  const found = useRosterItem({ _tag: "bot", botId });
  const name =
    found._tag === "found" && found.item._tag === "bot" ? found.item.bot.profile.name : "";
  const [load, setLoad] = useState<Load>(LOADING);
  const [sending, setSending] = useState(false);
  const title = t("template.share.title", { name });

  useLayoutEffect(() => {
    navigation.setOptions({ title });
  }, [navigation, title]);

  useEffect(() => {
    let current = true;
    void client.botTemplate(botId).then((result) => {
      if (current) setLoad(loaded(result));
    });
    return () => {
      current = false;
    };
  }, [client, botId]);

  return (
    <TemplateScreen
      bar={
        <View className="flex-row flex-wrap justify-end gap-2">
          {load._tag === "ready" ? (
            <Button
              variant="primary"
              label={t("template.share.send")}
              held={sending}
              onPress={() => {
                setSending(true);
                void sendTemplate(load.template, title).then((sent) => {
                  setSending(false);
                  if (!sent) say(t("template.share.sendFailed"));
                });
              }}
            />
          ) : (
            <Button label={t("template.close")} onPress={navigation.goBack} />
          )}
        </View>
      }
    >
      {load._tag === "loading" ? (
        <Lead>{t("template.share.loading")}</Lead>
      ) : load._tag === "failed" ? (
        <View className="items-start gap-3 px-5 pt-4">
          <Problem>{t("template.share.failed")}</Problem>
          <Button
            variant="secondary"
            label={t("template.share.retry")}
            onPress={() => {
              setLoad(LOADING);
              void client.botTemplate(botId).then((result) => setLoad(loaded(result)));
            }}
          />
        </View>
      ) : (
        <>
          <Lead>{t("template.share.body", { name: load.template.profile.name })}</Lead>
          <TemplatePreview template={load.template} />
          <View className="mx-5 mt-6 border-t border-border pt-4">
            <Quiet>{t("template.leftOut")}</Quiet>
          </View>
        </>
      )}
    </TemplateScreen>
  );
}

/**
 * Creating a bot from the template file the operator opened, which is
 * untrusted: they see all of it, the model it runs on here and the
 * permission mode it starts with, capped by the default unless they choose
 * more, and nothing is created until they press Create. Once it exists, its
 * conversation opens in place of this screen. Leaving lets the file go.
 */
export function NewFromTemplateScreen({
  navigation,
}: NativeStackScreenProps<Screens, "newFromTemplate">) {
  const opened = useOpenedTemplate();
  const read = opened?.read ?? null;
  // The template stays shown while the screen leaves, once its file is let go;
  // a file opened over it starts again from what it asks for.
  const [shown, setShown] = useState<{
    readonly template: BotTemplate;
    readonly opening: number;
  }>();
  if (read?._tag === "template" && read.template !== shown?.template) {
    setShown({ template: read.template, opening: (shown?.opening ?? 0) + 1 });
  }

  useEffect(() => {
    if (opened === null) return;
    return navigation.addListener("beforeRemove", opened.dismiss);
  }, [navigation, opened]);

  if (shown === undefined) return <View className="flex-1 bg-background" />;
  return (
    <TemplateForm key={shown.opening} template={shown.template} onCancel={navigation.goBack} />
  );
}

function TemplateForm({
  template,
  onCancel,
}: {
  readonly template: BotTemplate;
  readonly onCancel: () => void;
}) {
  const i18n = useI18n();
  const { t } = i18n;
  const client = useJ3Client();
  const engineStatus = useEngineStatus();
  const connected = useConnection()._tag === "connected";
  const openConversation = useReplaceWithConversation();
  const start = templateStart(template, engineStatus._tag === "ready" ? engineStatus.value : null);
  const [picked, setPicked] = useState<PermissionMode | null>(null);
  const [state, setState] = useState<"editing" | "creating" | "schedule" | "failed">("editing");
  const mode = picked ?? start.permissionMode;
  const { name } = template.profile;
  const creating = state === "creating";
  const model = start.model._tag === "none" ? null : start.model;
  const create = (draft: TemplateDraft) => {
    setState("creating");
    void client.createBotFromTemplate(draft).then((result) => {
      if (result._tag === "done") {
        openConversation({ _tag: "bot", botId: result.value.id });
        return;
      }
      setState(refusedWith(result, "schedule") ? "schedule" : "failed");
    });
  };
  return (
    <TemplateScreen
      bar={
        <>
          <Problem>
            {state === "schedule"
              ? t("template.create.schedule")
              : state === "failed"
                ? t("template.create.failed")
                : null}
          </Problem>
          {!connected && <Quiet>{t("template.create.offline")}</Quiet>}
          <View className="flex-row flex-wrap justify-end gap-2">
            <Button label={t("template.create.cancel")} onPress={onCancel} />
            <Button
              variant="primary"
              label={
                creating ? t("template.create.creating") : t("template.create.submit", { name })
              }
              disabled={model === null || !connected}
              held={creating}
              onPress={() => {
                if (model !== null) create({ template, model: model.choice, permissionMode: mode });
              }}
            />
          </View>
        </>
      }
    >
      <Lead>{t("template.create.body", { name })}</Lead>
      <View className="mx-5 mt-3 flex-row items-start gap-2 rounded-md bg-muted px-3 py-2">
        <View className="pt-0.5">
          <Icon icon={ShieldAlert} color="accent-muted-foreground" />
        </View>
        <Text className="min-w-0 flex-1 text-xs text-muted-foreground">
          {t("template.create.untrusted")}
        </Text>
      </View>
      <TemplatePreview template={template} routinesNote={t("template.routines.paused", { name })}>
        <Section open title={t("template.model")}>
          {model === null ? (
            <Problem>{t("template.create.noModel")}</Problem>
          ) : (
            <View className="flex-row items-start gap-3">
              <Icon icon={Cpu} color="accent-muted-foreground" />
              <View className="min-w-0 flex-1">
                <Text className="text-base text-foreground">{model.name}</Text>
                {model._tag === "replaced" && (
                  <Text className="text-sm text-muted-foreground">
                    {t("template.model.replaced", {
                      model: model.asked,
                      name,
                      replacement: model.name,
                    })}
                  </Text>
                )}
              </View>
            </View>
          )}
        </Section>
        <Section open title={t("template.permission")}>
          {start.asked !== null && (
            <Text className="text-sm text-muted-foreground">
              {t("template.permission.capped", {
                mode: permissionModeText(start.asked, i18n).name,
              })}
            </Text>
          )}
          <View accessibilityRole="radiogroup" className="gap-2">
            {PermissionMode.literals.map((option) => {
              const text = permissionModeText(option, i18n);
              return (
                <ChoiceRow
                  key={option}
                  kind="one"
                  label={text.name}
                  description={text.description}
                  selected={mode === option}
                  unavailable={creating}
                  onPress={() => setPicked(option)}
                />
              );
            })}
          </View>
        </Section>
      </TemplatePreview>
    </TemplateScreen>
  );
}

/**
 * Opens the template's preview when a template file is opened, over whatever
 * is shown, once the navigation is ready. A file that cannot make a bot is
 * said, and let go.
 */
export function TemplateOpener({
  navigation,
  ready,
}: {
  readonly navigation: NavigationContainerRefWithCurrent<Screens>;
  readonly ready: boolean;
}) {
  const i18n = useI18n();
  const opened = useOpenedTemplate();
  const say = useSay();
  useEffect(() => {
    if (opened === null || !ready) return;
    if (opened.read._tag !== "template") {
      say(templateReadText(opened.read, i18n));
      opened.dismiss();
      return;
    }
    if (navigation.getCurrentRoute()?.name !== "newFromTemplate") {
      navigation.navigate("newFromTemplate");
    }
  }, [opened, ready, navigation, say, i18n]);
  return null;
}
