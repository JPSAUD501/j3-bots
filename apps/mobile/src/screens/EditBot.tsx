// SPDX-License-Identifier: AGPL-3.0-or-later
import type { BotChanges, Save } from "@j3-bots/client-runtime";
import type { ProfileField } from "@j3-bots/client-runtime/presentation";
import {
  useBotEdit,
  useConnection,
  useEngineStatus,
  useJ3Client,
  useReadable,
} from "@j3-bots/client-runtime/react";
import { effortText, permissionModeText } from "@j3-bots/client-runtime/wording";
import { type Bot, PermissionMode, PROFILE_LIMITS } from "@j3-bots/contracts";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { View } from "react-native";
import { Text } from "../text.tsx";
import { AvatarPicker } from "../components/avatar/AvatarPicker.tsx";
import { BotAccountNotice } from "../components/BotAccountNotice.tsx";
import { Connecting } from "../components/ConnectionLine.tsx";
import {
  ChoiceRow,
  FormScreen,
  SwitchRow,
  TextField,
  useDiscardGuard,
} from "../components/form.tsx";
import { ModelPicker } from "../components/ModelPicker.tsx";
import { Gone } from "../conversation/ConversationView.tsx";
import { useI18n } from "../i18n.ts";
import type { Screens } from "../navigation.tsx";
import { useSay } from "../toast.tsx";
import { Button } from "../ui.tsx";
import { useRosterItem } from "./rosterItem.ts";

type Props = NativeStackScreenProps<Screens, "editBot">;

/**
 * Everything the operator changes about a bot itself, on a screen of its own.
 * Once the server has the changes the screen closes; one that closes before
 * the answer says in a toast when the changes did not save. Leaving lets go
 * of a failed save, as the operator gave up on it; a save under way goes on.
 * Opened `at` the title, as Give a title does, its title field has the focus;
 * opened at the model, as a bot whose AI account went away offers, the model
 * picker is open.
 */
export function EditBotScreen({ navigation, route }: Props) {
  const { t } = useI18n();
  const client = useJ3Client();
  const say = useSay();
  const { botId, at } = route.params;
  const found = useRosterItem({ _tag: "bot", botId });
  const bot = found._tag === "found" && found.item._tag === "bot" ? found.item.bot : null;
  const name = bot?.profile.name ?? "";
  useLayoutEffect(() => {
    navigation.setOptions({ title: t("editBot.title", { name }) });
  }, [navigation, t, name]);
  const open = useRef(true);
  useEffect(() => {
    open.current = true;
    return () => {
      open.current = false;
    };
  }, []);
  if (found._tag === "loading") return <Connecting />;
  if (bot === null) {
    return (
      <View className="flex-1 bg-background">
        <Gone onBack={() => navigation.popTo("roster")} />
      </View>
    );
  }
  return (
    <EditBotForm
      bot={bot}
      atTitle={at === "title"}
      atModel={at === "model"}
      onClose={navigation.goBack}
      onSave={(changes, leave) =>
        void client.updateBot(bot.id, changes).then((result) => {
          if (open.current) {
            if (result._tag === "done") leave();
          } else if (result._tag === "failed") {
            say(t("editBot.failedClosed", { name: bot.profile.name }));
          }
        })
      }
    />
  );
}

/**
 * The form: name, title, look and job, the model with its effort and speed, the permission mode, and
 * whether it stays behind the scenes, out of the roster's list. Save sends only what changed. While a save is under way the form shows what it
 * sends and takes no edit; a save that fails leaves the edits in place and
 * says why, beside the field when one field is the reason.
 */
function EditBotForm({
  bot,
  atTitle,
  atModel,
  onClose,
  onSave,
}: {
  /** The bot as the server has it now. Fields the operator left alone follow it. */
  readonly bot: Bot;
  /** The title field takes the focus as the form opens. */
  readonly atTitle: boolean;
  /** The model picker is open as the form opens. */
  readonly atModel: boolean;
  readonly onClose: () => void;
  /** `leave` closes the screen without asking about the edits it saved. */
  readonly onSave: (changes: BotChanges, leave: () => void) => void;
}) {
  const i18n = useI18n();
  const { t } = i18n;
  const client = useJ3Client();
  const engineStatus = useEngineStatus();
  const engine = engineStatus._tag === "ready" ? engineStatus.value : null;
  const connected = useConnection()._tag === "connected";
  const save: Save<BotChanges> | undefined = useReadable(client.botSaves).get(bot.id);
  const form = useBotEdit({ bot, engine, save, connected });
  const { saving, problem, setting, effort } = form;
  const [pickerOpen, setPickerOpen] = useState(atModel);
  const leave = useDiscardGuard(form.unsaved && !saving, () => client.dismissBotSave(bot.id));

  const fieldError = (field: ProfileField) => {
    const fieldProblem = form.fieldProblem(field);
    return fieldProblem === null
      ? null
      : fieldProblem === "required"
        ? t(field === "title" ? "editBot.title.required" : "editBot.name.required")
        : t("editBot.tooLong", { max: PROFILE_LIMITS[field] });
  };

  return (
    <FormScreen
      problem={
        problem === "gone"
          ? t("editBot.gone", { name: bot.profile.name })
          : problem !== null && problem !== "model"
            ? t("editBot.failed")
            : null
      }
      offline={!connected}
      actions={
        <>
          <Button label={t("editBot.cancel")} onPress={onClose} />
          <Button
            variant="primary"
            label={saving ? t("editBot.saving") : t("editBot.save")}
            disabled={form.changes === null}
            onPress={() => {
              if (form.changes !== null) onSave(form.changes, () => leave(onClose));
            }}
          />
        </>
      }
    >
      <TextField
        label={t("editBot.name")}
        value={form.name}
        maxLength={PROFILE_LIMITS.name}
        readOnly={saving}
        autoCapitalize="words"
        onChange={(value) => form.editText("name", value)}
        error={fieldError("name")}
      />
      <TextField
        label={t("editBot.titleField")}
        value={form.title}
        maxLength={PROFILE_LIMITS.title}
        readOnly={saving}
        placeholder={t("editBot.titleField.placeholder")}
        autoFocus={atTitle}
        onChange={(value) => form.editText("title", value)}
        error={fieldError("title")}
      />
      <AvatarPicker
        value={form.avatar}
        onChange={(avatar) => form.edit({ avatar })}
        name={form.name}
        seed={bot.id}
        readOnly={saving}
      />
      <TextField
        label={t("editBot.job")}
        value={form.job}
        maxLength={PROFILE_LIMITS.job}
        readOnly={saving}
        multiline
        hint={t("editBot.job.hint", { name: bot.profile.name })}
        onChange={(value) => form.editText("job", value)}
        error={fieldError("job")}
      />

      <View className="gap-2">
        <ModelPicker
          engine={engine}
          value={setting}
          onChange={form.editModel}
          label={t("editBot.model")}
          title={t("picker.open", { name: bot.profile.name })}
          offerEffort
          readOnly={saving}
          open={pickerOpen}
          onOpenChange={setPickerOpen}
        />
        {!saving && (
          <BotAccountNotice
            engine={engine}
            model={setting.model}
            name={bot.profile.name}
            onChoose={() => setPickerOpen(true)}
          />
        )}
        {form.modelUnavailable && (
          <Text accessibilityLiveRegion="polite" role="alert" className="text-sm text-blocked">
            {t("editBot.model.unavailable")}
          </Text>
        )}
        {effort.fallback !== null && (
          <Text accessibilityLiveRegion="polite" className="text-sm text-muted-foreground">
            {t("editBot.effort.fallback", {
              model: effort.fallback.modelName,
              level: effortText(effort.fallback.level, i18n),
              name: bot.profile.name,
            })}
          </Text>
        )}
      </View>

      <View accessibilityRole="radiogroup" className="gap-2">
        <Text className="text-sm text-foreground">{t("editBot.permissionMode")}</Text>
        {PermissionMode.literals.map((option) => {
          const text = permissionModeText(option, i18n);
          return (
            <ChoiceRow
              key={option}
              kind="one"
              label={text.name}
              description={text.description}
              selected={form.permissionMode === option}
              unavailable={saving}
              onPress={() => form.edit({ permissionMode: option })}
            />
          );
        })}
      </View>

      {form.settingsChange && (
        <Text className="text-sm text-muted-foreground">
          {t("editBot.nextTurn", { name: bot.profile.name })}
          {form.providerChange &&
            ` ${t("editBot.providerChangeStops", { name: bot.profile.name })}`}
        </Text>
      )}

      <SwitchRow
        label={t("backstage.keep")}
        hint={t("backstage.keep.hint")}
        value={form.hidden}
        readOnly={saving}
        onChange={(hidden) => form.edit({ hidden })}
      />
    </FormScreen>
  );
}
