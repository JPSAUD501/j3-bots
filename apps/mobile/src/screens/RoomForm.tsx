// SPDX-License-Identifier: AGPL-3.0-or-later
import type { IntentFailure } from "@j3-bots/client-runtime";
import {
  ROOM_NAME_MAX,
  type RoomFormMode,
  roomFormTarget,
} from "@j3-bots/client-runtime/presentation";
import {
  type RoomSubmission,
  useConnection,
  useJ3Client,
  useRoomForm,
} from "@j3-bots/client-runtime/react";
import type { Bot, Room, RoomId } from "@j3-bots/contracts";
import { useNavigation } from "@react-navigation/native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { View } from "react-native";
import { Text } from "../text.tsx";
import { BotAvatar } from "../components/avatar/BotAvatar.tsx";
import { Connecting } from "../components/ConnectionLine.tsx";
import {
  ChoiceRow,
  FormScreen,
  Problem,
  SwitchRow,
  TextField,
  useDiscardGuard,
} from "../components/form.tsx";
import { useI18n } from "../i18n.ts";
import { type Screens, useReplaceWithConversation } from "../navigation.tsx";
import { useBots } from "../presentation.tsx";
import { useSay } from "../toast.tsx";
import { Button } from "../ui.tsx";
import { useRosterItem } from "./rosterItem.ts";

type Props = NativeStackScreenProps<Screens, "roomForm">;

/**
 * The room form on a screen of its own. Once the server has what it sent the
 * screen closes, and a new room's conversation opens in its place; a failure
 * stays on the screen, or, once it has closed, a toast says so.
 */
export function RoomFormScreen({ navigation, route }: Props) {
  const { form } = route.params;
  return form._tag === "create" ? (
    <RoomFormFor mode={form} navigation={navigation} />
  ) : (
    <ExistingRoom roomId={form.roomId} purpose={form._tag} navigation={navigation} />
  );
}

/** The form on a room the roster has, which it keeps showing, saying so, once the room is deleted. */
function ExistingRoom({
  roomId,
  purpose,
  navigation,
}: {
  readonly roomId: RoomId;
  readonly purpose: "edit" | "unarchive";
  readonly navigation: Props["navigation"];
}) {
  const found = useRosterItem({ _tag: "room", roomId });
  const room = found._tag === "found" && found.item._tag === "room" ? found.item.room : null;
  // The room the form was last open on.
  const [lastRoom, setLastRoom] = useState<Room | null>(null);
  if (room !== null && room !== lastRoom) setLastRoom(room);
  const shown = room ?? lastRoom;
  const gone = found._tag === "gone";
  // Kept while the room and what the form says of it stay the same.
  const mode = useMemo(
    (): RoomFormMode | null => shown && { _tag: purpose, room: shown, gone },
    [purpose, shown, gone],
  );
  if (mode === null) return <Connecting />;
  return <RoomFormFor mode={mode} navigation={navigation} />;
}

/** Sends what the form holds, and closes the screen once the server has it. */
function RoomFormFor({
  mode,
  navigation,
}: {
  readonly mode: RoomFormMode;
  readonly navigation: Props["navigation"];
}) {
  const { t } = useI18n();
  const client = useJ3Client();
  const say = useSay();
  const openConversation = useReplaceWithConversation();
  const open = useRef(true);
  useEffect(() => {
    open.current = true;
    return () => {
      open.current = false;
    };
  }, []);

  const send = (
    submission: RoomSubmission,
    leave: (go: () => void) => void,
  ): Promise<IntentFailure | null> => {
    if (submission._tag === "create") {
      return client.createRoom(submission.draft).then((result) => {
        if (result._tag === "done") {
          if (open.current)
            leave(() => openConversation({ _tag: "room", roomId: result.value.id }));
          return null;
        }
        if (!open.current) say(t("roomForm.createFailedClosed", { name: submission.draft.name }));
        return result.failure;
      });
    }
    if (mode._tag === "create") return Promise.resolve(null);
    const { room } = mode;
    return client.updateRoom(room.id, submission.changes).then((result) => {
      if (result._tag === "done") {
        if (open.current) leave(navigation.goBack);
        return null;
      }
      if (!open.current) say(t("roomForm.failedClosed", { name: room.name }));
      return result.failure;
    });
  };

  return (
    <RoomForm
      // Another target is another form, so what was typed never carries over to it.
      key={roomFormTarget(mode)}
      mode={mode}
      send={send}
      onClose={navigation.goBack}
    />
  );
}

/**
 * A room's name, its bots, and, unless it is being unarchived, whether it is
 * hidden from the roster's list. What is missing is said once
 * the operator tries to send; a refusal from the server is said under the
 * form, or beside the bots when they are the reason, and keeps what was
 * typed. What the operator left alone follows the room as the server has it;
 * Save sends only what the form changes, and with nothing changed it closes
 * without asking the server. A bot picked and deleted meanwhile leaves the
 * selection, which says so; a room deleted meanwhile keeps the form open,
 * saying so, and saves nothing.
 */
function RoomForm({
  mode,
  send,
  onClose,
}: {
  readonly mode: RoomFormMode;
  /** Resolves with why it failed, or null once the server has it; `leave` closes without asking. */
  readonly send: (
    submission: RoomSubmission,
    leave: (go: () => void) => void,
  ) => Promise<IntentFailure | null>;
  readonly onClose: () => void;
}) {
  const { t, plural, locale } = useI18n();
  const connected = useConnection()._tag === "connected";
  const botsById = useBots();
  // Every bot the operator has, to pick members from; the same list while the bots stay the same.
  const bots = useMemo((): ReadonlyArray<Bot> => [...botsById.values()], [botsById]);
  const form = useRoomForm({ mode, bots, connected, locale });
  const { room, values, problems, busy, dropped } = form;
  const leave = useDiscardGuard(form.unsaved && !busy);

  const name = room?.name ?? "";
  const failureText =
    form.failure === null
      ? null
      : {
          gone: t("roomForm.gone", { name }),
          archived: t("roomForm.archived", { name }),
          "create-failed": t("roomForm.createFailed"),
          failed: t("roomForm.failed"),
        }[form.failure];
  const submit = () => {
    if (form.submit((submission) => send(submission, leave)) === "unchanged") onClose();
  };

  const title =
    mode._tag === "create"
      ? t("roomForm.newTitle")
      : mode._tag === "edit"
        ? t("roomForm.editTitle", { name })
        : t("roomForm.unarchiveTitle", { name });
  const navigation = useNavigation();
  useLayoutEffect(() => navigation.setOptions({ title }), [navigation, title]);
  const submitText = busy
    ? mode._tag === "create"
      ? t("roomForm.creating")
      : t("roomForm.saving")
    : mode._tag === "create"
      ? t("roomForm.create")
      : mode._tag === "edit"
        ? t("roomForm.save")
        : t("roomForm.unarchive");

  return (
    <FormScreen
      problem={failureText}
      offline={!connected}
      actions={
        <>
          <Button label={t("roomForm.cancel")} onPress={onClose} />
          <Button
            variant="primary"
            label={submitText}
            disabled={!form.canSubmit}
            onPress={submit}
          />
        </>
      }
    >
      {mode._tag === "unarchive" && (
        <Text className="text-sm text-muted-foreground">
          {t("roomForm.unarchiveBody", { name })}
        </Text>
      )}

      <TextField
        label={t("roomForm.name")}
        value={values.name}
        maxLength={ROOM_NAME_MAX}
        readOnly={busy}
        onChange={(text) => form.change({ ...values, name: text })}
        error={problems.has("name") ? t("roomForm.name.required") : null}
      />

      <View className="gap-2">
        <Text className="text-sm text-foreground">{t("roomForm.members")}</Text>
        <Text className="text-xs text-muted-foreground">{t("roomForm.members.hint")}</Text>
        {form.choices.map((bot) => {
          const picked = values.members.includes(bot.id);
          return (
            <ChoiceRow
              key={bot.id}
              kind="any"
              label={bot.profile.name}
              {...(bot.profile.title === "" ? {} : { description: bot.profile.title })}
              selected={picked}
              // A seventh bot cannot be added: its row stays in reach and does nothing.
              unavailable={busy || (form.full && !picked)}
              leading={
                <BotAvatar avatar={bot.profile.avatar} seed={bot.id} state="idle" size={24} still />
              }
              onPress={() => form.toggleMember(bot.id)}
            />
          );
        })}
        <Problem>
          {form.membersRefused
            ? t("roomForm.membersRefused")
            : problems.has("members")
              ? t("roomForm.members.invalid")
              : null}
        </Problem>
        {dropped.length > 0 && (
          <Text accessibilityLiveRegion="polite" className="text-xs text-muted-foreground">
            {plural("roomForm.dropped", dropped.length, {
              names: new Intl.ListFormat(locale, { type: "conjunction" }).format(dropped),
            })}
          </Text>
        )}
      </View>

      {/* Unarchiving asks only for what the room needs to take messages again. */}
      {mode._tag !== "unarchive" && (
        <SwitchRow
          label={t("visibility.hide")}
          hint={t("visibility.hide.hint")}
          value={values.hidden}
          readOnly={busy}
          onChange={(hidden) => form.change({ ...values, hidden })}
        />
      )}
    </FormScreen>
  );
}
