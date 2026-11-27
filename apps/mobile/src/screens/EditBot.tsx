// SPDX-License-Identifier: AGPL-3.0-or-later
import type { BotChanges, Save } from "@j3-bots/client-runtime";
import { type ProfileField, sameModel } from "@j3-bots/client-runtime/presentation";
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
import { useEffect, useLayoutEffect, useRef } from "react";
import { View } from "react-native";
import { Text } from "../text.tsx";
import { AvatarPicker } from "../components/avatar/AvatarPicker.tsx";
import { Connecting } from "../components/ConnectionLine.tsx";
import {
  ChoiceRow,
  FormScreen,
  SwitchRow,
  TextField,
  useDiscardGuard,
} from "../components/form.tsx";
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
 */
export function EditBotScreen({ navigation, route }: Props) {
  const { t } = useI18n();
  const client = useJ3Client();
  const say = useSay();
  const { botId } = route.params;
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
 * The form: name, title, look and job, the model and its effort, the permission mode, and
 * whether it is hidden from the roster's list. Save sends only what changed. While a save is under way the form shows what it
 * sends and takes no edit; a save that fails leaves the edits in place and
 * says why, beside the field when one field is the reason.
 */
function EditBotForm({
  bot,
  onClose,
  onSave,
}: {
  /** The bot as the server has it now. Fields the operator left alone follow it. */
  readonly bot: Bot;
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
  const { saving, problem, choices, model, effort } = form;
  const leave = useDiscardGuard(form.unsaved && !saving, () => client.dismissBotSave(bot.id));

  const fieldError = (field: ProfileField) => {
    const fieldProblem = form.fieldProblem(field);
    return fieldProblem === null
      ? null
      : fieldProblem === "required"
        ? t("editBot.name.required")
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

      <View accessibilityRole="radiogroup" className="gap-2">
        <Text className="text-sm text-foreground">{t("editBot.model")}</Text>
        {choices.unoffered.map((choice) => (
          <ChoiceRow
            key={`${choice.providerId}/${choice.modelId}`}
            kind="one"
            label={
              engine === null
                ? choice.modelId
                : t("editBot.model.notOffered", { model: choice.modelId })
            }
            selected={sameModel(choice, model)}
            unavailable={saving}
            onPress={() => form.edit({ model: choice })}
          />
        ))}
        {choices.groups.map((group) => (
          <View key={group.providerName} className="gap-2">
            <Text className="text-xs text-muted-foreground">{group.providerName}</Text>
            {group.models.map((option) => (
              <ChoiceRow
                key={`${option.choice.providerId}/${option.choice.modelId}`}
                kind="one"
                label={option.name}
                selected={sameModel(option.choice, model)}
                unavailable={saving}
                onPress={() => form.edit({ model: option.choice })}
              />
            ))}
          </View>
        ))}
        {form.modelUnavailable && (
          <Text accessibilityLiveRegion="polite" role="alert" className="text-sm text-blocked">
            {t("editBot.model.unavailable")}
          </Text>
        )}
        {choices.someNotReady && (
          <Text className="text-xs text-muted-foreground">{t("editBot.model.someNotReady")}</Text>
        )}
      </View>

      {(effort.levels.length > 0 || effort.fallback !== null) && (
        <View
          accessibilityRole={effort.levels.length > 0 ? "radiogroup" : undefined}
          className="gap-2"
        >
          {effort.levels.length > 0 && (
            <>
              <Text className="text-sm text-foreground">{t("editBot.effort")}</Text>
              <Text className="text-xs text-muted-foreground">{t("editBot.effort.hint")}</Text>
              <ChoiceRow
                kind="one"
                label={effortText(null, i18n)}
                selected={effort.shown === null}
                unavailable={saving}
                onPress={() => form.edit({ effort: { level: null } })}
              />
              {effort.levels.map((level) => (
                <ChoiceRow
                  key={level.id}
                  kind="one"
                  label={effortText(level, i18n)}
                  selected={effort.shown === level.id}
                  unavailable={saving}
                  onPress={() => form.edit({ effort: { level: level.id } })}
                />
              ))}
            </>
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
      )}

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
        label={t("visibility.hide")}
        hint={t("visibility.hide.hint")}
        value={form.hidden}
        readOnly={saving}
        onChange={(hidden) => form.edit({ hidden })}
      />
    </FormScreen>
  );
}
