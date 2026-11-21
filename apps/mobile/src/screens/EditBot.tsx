// SPDX-License-Identifier: AGPL-3.0-or-later
import type { BotChanges, Save } from "@j3-bots/client-runtime";
import {
  type BotEdits,
  botPatch,
  editsAfterFailedBotSave,
  modelChoices,
  noBotEdits,
  type ProfileField,
  sameModel,
  shownSaveProblem,
  withChanges,
  withProfileEdit,
} from "@j3-bots/client-runtime/presentation";
import {
  useConnection,
  useEngineStatus,
  useJ3Client,
  useReadable,
} from "@j3-bots/client-runtime/react";
import { permissionModeText } from "@j3-bots/client-runtime/wording";
import { type Bot, PermissionMode, PROFILE_LIMITS } from "@j3-bots/contracts";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Text, View } from "react-native";
import { Connecting } from "../components/ConnectionLine.tsx";
import { ChoiceRow, FormScreen, TextField, useDiscardGuard } from "../components/form.tsx";
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
 * of a failed save, as the operator gave up on it.
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
      client.dismissBotSave(botId);
    };
  }, [client, botId]);
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
 * The form: name, title and job, the model and the permission mode. Save
 * sends only what changed. While a save is under way the form shows what it
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
  const [edits, setEdits] = useState<BotEdits>(() =>
    save?._tag === "failed" ? editsAfterFailedBotSave(noBotEdits, save.changes) : noBotEdits,
  );
  // A failure shows until the operator edits again.
  const [failureShown, setFailureShown] = useState(save?._tag === "failed");
  const [lastSave, setLastSave] = useState(save);
  if (lastSave !== save) {
    setLastSave(save);
    if (save?._tag === "failed") {
      setEdits((current) => editsAfterFailedBotSave(current, save.changes));
      setFailureShown(true);
    }
  }
  const edit = (change: Partial<BotEdits>) => {
    setEdits((current) => ({ ...current, ...change }));
    setFailureShown(false);
  };
  // What each text field showed when its edit started: typing it back ends the edit.
  const [startedFrom, setStartedFrom] = useState<Readonly<Record<ProfileField, string | null>>>({
    name: null,
    title: null,
    job: null,
  });
  const editText = (field: ProfileField, value: string) => {
    const from = startedFrom[field] ?? bot.profile[field];
    setStartedFrom((current) => ({ ...current, [field]: value === from ? null : from }));
    setEdits((current) => withProfileEdit(current, field, value, from));
    setFailureShown(false);
  };

  const saving = save?._tag === "saving";
  const shown = saving ? withChanges(bot, save.changes) : bot;
  const name = edits.name ?? shown.profile.name;
  const title = edits.title ?? shown.profile.title;
  const job = edits.job ?? shown.profile.job;
  const model = edits.model ?? shown.model;
  const mode = edits.permissionMode ?? shown.permissionMode;
  const patch = botPatch(bot, edits);
  const invalid = patch._tag === "invalid" ? patch.fields : new Set<ProfileField>();
  const problem = shownSaveProblem(save, !failureShown);
  const choices = modelChoices(engine, bot.model, edits.model);
  const modelMessage =
    problem === "model" || choices.pickUnavailable ? t("editBot.model.unavailable") : null;
  const settingsChange = !sameModel(model, bot.model) || mode !== bot.permissionMode;
  const providerChange = model.providerId !== bot.model.providerId;
  const canSave = patch._tag === "changes" && !choices.pickUnavailable && !saving && connected;
  const leave = useDiscardGuard(patch._tag !== "unchanged");

  const fieldError = (field: ProfileField) =>
    !invalid.has(field)
      ? null
      : field === "name" && name.trim() === ""
        ? t("editBot.name.required")
        : t("editBot.tooLong", { max: PROFILE_LIMITS[field] });

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
            disabled={!canSave}
            onPress={() => {
              if (patch._tag === "changes" && canSave) {
                onSave(patch.changes, () => leave(onClose));
              }
            }}
          />
        </>
      }
    >
      <TextField
        label={t("editBot.name")}
        value={name}
        maxLength={PROFILE_LIMITS.name}
        readOnly={saving}
        autoCapitalize="words"
        onChange={(value) => editText("name", value)}
        error={fieldError("name")}
      />
      <TextField
        label={t("editBot.titleField")}
        value={title}
        maxLength={PROFILE_LIMITS.title}
        readOnly={saving}
        placeholder={t("editBot.titleField.placeholder")}
        onChange={(value) => editText("title", value)}
        error={fieldError("title")}
      />
      <TextField
        label={t("editBot.job")}
        value={job}
        maxLength={PROFILE_LIMITS.job}
        readOnly={saving}
        multiline
        hint={t("editBot.job.hint", { name: bot.profile.name })}
        onChange={(value) => editText("job", value)}
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
            onPress={() => edit({ model: choice })}
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
                onPress={() => edit({ model: option.choice })}
              />
            ))}
          </View>
        ))}
        {modelMessage !== null && (
          <Text accessibilityLiveRegion="polite" role="alert" className="text-sm text-blocked">
            {modelMessage}
          </Text>
        )}
        {choices.someNotReady && (
          <Text className="text-xs text-muted-foreground">{t("editBot.model.someNotReady")}</Text>
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
              selected={mode === option}
              unavailable={saving}
              onPress={() => edit({ permissionMode: option })}
            />
          );
        })}
      </View>

      {settingsChange && (
        <Text className="text-sm text-muted-foreground">
          {t("editBot.nextTurn", { name: bot.profile.name })}
          {providerChange && ` ${t("editBot.providerChangeStops", { name: bot.profile.name })}`}
        </Text>
      )}
    </FormScreen>
  );
}
