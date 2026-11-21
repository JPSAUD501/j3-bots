// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  type IntentFailure,
  refusedWith,
  type RoomChanges,
  type RoomDraft,
} from "@j3-bots/client-runtime";
import {
  blankRoomForm,
  followRoom,
  hostOf,
  ROOM_MEMBERS,
  ROOM_NAME_MAX,
  roomChanges,
  roomDraft,
  roomFormContext,
  type RoomFormMode,
  roomFormOf,
  type RoomFormProblem,
  roomFormTarget,
  sameRoomForm,
  withMember,
  withoutDeleted,
} from "@j3-bots/client-runtime/presentation";
import { useConnection, useJ3Client, useSettings } from "@j3-bots/client-runtime/react";
import type { Bot, BotId, Room, RoomId } from "@j3-bots/contracts";
import { useNavigation } from "@react-navigation/native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Text, View } from "react-native";
import { AvatarShape } from "../components/Avatar.tsx";
import { Connecting } from "../components/ConnectionLine.tsx";
import { ChoiceRow, FormScreen, Problem, TextField, useDiscardGuard } from "../components/form.tsx";
import { useI18n } from "../i18n.ts";
import { type Screens, useReplaceWithConversation } from "../navigation.tsx";
import { useBots } from "../presentation.tsx";
import { useSay } from "../toast.tsx";
import { Button } from "../ui.tsx";
import { useRosterItem } from "./rosterItem.ts";

type Props = NativeStackScreenProps<Screens, "roomForm">;

/** What the form sends: a new room, or changes to the one it edits. */
type RoomSubmission =
  | { readonly _tag: "create"; readonly draft: RoomDraft }
  | { readonly _tag: "update"; readonly changes: RoomChanges };

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

  const submit = (
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
      onSubmit={submit}
      onClose={navigation.goBack}
    />
  );
}

/**
 * A room's name, its bots, which of them hosts, and how many replies in a
 * row bots may trade before the room waits for the operator. The host
 * follows the bots picked: the one the operator chose while it stays in,
 * else the primary bot, else the first picked; a room the server has without
 * a host shows none until the operator picks one. What is missing is said once
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
  onSubmit,
  onClose,
}: {
  readonly mode: RoomFormMode;
  /** Resolves with why it failed, or null once the server has it. */
  readonly onSubmit: (
    submission: RoomSubmission,
    leave: (go: () => void) => void,
  ) => Promise<IntentFailure | null>;
  readonly onClose: () => void;
}) {
  const { t, plural, locale } = useI18n();
  const connected = useConnection()._tag === "connected";
  const settings = useSettings();
  const defaultHopLimit = settings._tag === "ready" ? settings.value.budgets.hops : null;
  const botsById = useBots();
  // Every bot the operator has, to pick members from; the same list while the bots stay the same.
  const bots = useMemo((): ReadonlyArray<Bot> => [...botsById.values()], [botsById]);
  const room = mode._tag === "create" ? null : mode.room;
  const gone = mode._tag !== "create" && mode.gone;
  // Where the form starts: the room as the server has it, or nothing.
  const [start, setStart] = useState(() => (room === null ? blankRoomForm : roomFormOf(room)));
  const [values, setValues] = useState(start);
  const primaryId = bots.find((bot) => bot.primary)?.id ?? null;
  const context = roomFormContext(room, primaryId, defaultHopLimit);
  // Bots picked and then deleted elsewhere, by name, which leave the selection and are named under it.
  const [dropped, setDropped] = useState<ReadonlyArray<string>>([]);
  const [botsSeen, setBotsSeen] = useState(bots);
  const [roomSeen, setRoomSeen] = useState(room);
  if (botsSeen !== bots || roomSeen !== room) {
    let nextStart = start;
    let nextValues = values;
    if (botsSeen !== bots) {
      setBotsSeen(bots);
      const present = new Set<BotId>(bots.map((bot) => bot.id));
      // The server drops them from the room too, which the form follows once the room says so.
      nextStart = withoutDeleted(start, present);
      nextValues = withoutDeleted(values, present, nextStart.hostPick);
      const deleted = values.members.filter((id) => !present.has(id));
      if (deleted.length > 0) {
        const names = new Map(botsSeen.map((bot) => [bot.id, bot.profile.name]));
        setDropped([...dropped, ...deleted.flatMap((id) => names.get(id) ?? [])]);
      }
    }
    if (roomSeen !== room) {
      setRoomSeen(room);
      if (room !== null) {
        const followed = followRoom(nextStart, nextValues, room, context);
        nextStart = followed.start;
        nextValues = followed.values;
      }
    }
    setStart(nextStart);
    setValues(nextValues);
  }
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<IntentFailure | null>(null);
  // What is missing shows once the operator tried to send, and follows the form from then on.
  const [tried, setTried] = useState(false);

  const hostId = hostOf(values, context);
  const draft = room === null ? roomDraft(values, context) : null;
  const changes = room === null ? null : roomChanges(start, values, context);
  // What goes to the server, once nothing is missing.
  const submission: RoomSubmission | null =
    draft?._tag === "ready"
      ? { _tag: "create", draft: draft.value }
      : changes?._tag === "ready"
        ? {
            _tag: "update",
            changes:
              mode._tag === "unarchive" ? { ...changes.value, archived: false } : changes.value,
          }
        : null;
  const missing =
    draft?._tag === "invalid"
      ? draft.problems
      : changes?._tag === "invalid"
        ? changes.problems
        : null;
  const problems: ReadonlySet<RoomFormProblem> = tried && missing !== null ? missing : new Set();
  const full = values.members.length >= ROOM_MEMBERS.max;
  const leave = useDiscardGuard(!sameRoomForm(start, values, context));

  const change = (next: typeof values) => {
    if (busy) return;
    setValues(next);
    setFailure(null);
  };
  const members = values.members.flatMap((id) => {
    const bot = botsById.get(id);
    return bot ? [bot] : [];
  });
  const choices = bots.toSorted((a, b) => a.profile.name.localeCompare(b.profile.name, locale));

  const name = room?.name ?? "";
  const refusedMembers = refusedWith(failure, "room-members");
  const failureText = gone
    ? t("roomForm.gone", { name })
    : failure === null || refusedMembers
      ? null
      : failure._tag === "refused" && failure.error._tag === "Conflict"
        ? t("roomForm.archived", { name })
        : failure._tag === "refused" && failure.error._tag === "NotFound" && room !== null
          ? t("roomForm.gone", { name })
          : room === null
            ? t("roomForm.createFailed")
            : t("roomForm.failed");

  const submit = () => {
    if (busy || !connected || gone) return;
    setTried(true);
    if (submission === null) return;
    // Nothing changed: there is nothing to ask the server.
    if (submission._tag === "update" && Object.keys(submission.changes).length === 0) {
      onClose();
      return;
    }
    setBusy(true);
    setFailure(null);
    void onSubmit(submission, leave).then((failed) => {
      setBusy(false);
      setFailure(failed);
    });
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
            disabled={busy || !connected || gone}
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
        onChange={(text) => change({ ...values, name: text })}
        error={problems.has("name") ? t("roomForm.name.required") : null}
      />

      <View className="gap-2">
        <Text className="text-sm text-foreground">{t("roomForm.members")}</Text>
        <Text className="text-xs text-muted-foreground">{t("roomForm.members.hint")}</Text>
        {choices.map((bot) => {
          const picked = values.members.includes(bot.id);
          return (
            <ChoiceRow
              key={bot.id}
              kind="any"
              label={bot.profile.name}
              {...(bot.profile.title === "" ? {} : { description: bot.profile.title })}
              selected={picked}
              // A seventh bot cannot be added: its row stays in reach and does nothing.
              unavailable={busy || (full && !picked)}
              leading={<AvatarShape avatar={bot.profile.avatar} size={20} />}
              onPress={() => change(withMember(values, bot.id, !picked))}
            />
          );
        })}
        <Problem>
          {refusedMembers
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

      {members.length > 0 && (
        <View accessibilityRole="radiogroup" className="gap-2">
          <Text className="text-sm text-foreground">{t("roomForm.host")}</Text>
          <Text className="text-xs text-muted-foreground">{t("roomForm.host.hint")}</Text>
          {/* A room the server has without a host shows none picked until the operator picks one. */}
          {members.map((bot) => (
            <ChoiceRow
              key={bot.id}
              kind="one"
              label={bot.profile.name}
              selected={bot.id === hostId}
              unavailable={busy}
              onPress={() => change({ ...values, hostPick: bot.id })}
            />
          ))}
          <Problem>{problems.has("host") ? t("roomForm.host.required") : null}</Problem>
        </View>
      )}

      <TextField
        label={t("roomForm.hopLimit")}
        value={values.hopLimit}
        numeric
        readOnly={busy}
        {...(defaultHopLimit === null ? {} : { placeholder: String(defaultHopLimit) })}
        hint={
          defaultHopLimit === null
            ? t("roomForm.hopLimit.hint")
            : `${t("roomForm.hopLimit.hint")} ${t("roomForm.hopLimit.default", { count: defaultHopLimit })}`
        }
        onChange={(text) => change({ ...values, hopLimit: text })}
        error={problems.has("hop-limit") ? t("roomForm.hopLimit.invalid") : null}
      />
    </FormScreen>
  );
}
