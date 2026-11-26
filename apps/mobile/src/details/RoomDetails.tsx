// SPDX-License-Identifier: AGPL-3.0-or-later
import { roomStop } from "@j3-bots/client-runtime/presentation";
import type { Room } from "@j3-bots/contracts";
import { useNavigation } from "@react-navigation/native";
import { ScrollView, View } from "react-native";
import { Text } from "../text.tsx";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { RoomAvatar } from "../components/avatar/BotAvatar.tsx";
import { LiveBotAvatar } from "../components/avatar/mood.tsx";
import { DeleteButton, PendingButton, Quiet, Section } from "../components/form.tsx";
import { useConfirm } from "../confirm.tsx";
import { useI18n } from "../i18n.ts";
import type { Navigation } from "../navigation.tsx";
import { useBots } from "../presentation.tsx";
import { Button } from "../ui.tsx";
import { useRoomPlacing } from "../screens/placing.ts";
import { useRoomActions } from "./actions.ts";
import { HiddenNotice } from "./HiddenNotice.tsx";
import { Apart, Profile, ProfileLine } from "./Profile.tsx";
import { StopRow, useFocusAfterStop } from "./StopRow.tsx";

/**
 * A room's details: who is in it, how long bots may talk among
 * themselves, and what the operator does to the room itself. While the room's
 * work is under way, Stop comes first under its profile, and asks first; a
 * hidden room says so after it, with Show.
 */
export function RoomDetails({ room }: { readonly room: Room }) {
  const { t, plural } = useI18n();
  const insets = useSafeAreaInsets();
  const navigation = useNavigation<Navigation>();
  const bots = useBots();
  const actions = useRoomActions();
  const placing = useRoomPlacing();
  const confirm = useConfirm();
  const stopping = roomStop(room);
  const stopFocus = useFocusAfterStop(stopping !== "hidden");
  const { name } = room;
  const archived = room.status === "archived";
  const members = room.members.flatMap((id) => {
    const bot = bots.get(id);
    return bot === undefined ? [] : [bot];
  });
  return (
    <ScrollView
      className="flex-1 bg-background"
      contentContainerStyle={{ paddingBottom: insets.bottom + 24 }}
    >
      <Profile
        picture={
          <RoomAvatar
            members={members.map((bot) => ({ id: bot.id, avatar: bot.profile.avatar }))}
            size={96}
          />
        }
        name={name}
        headingRef={stopFocus.heading}
        badge={archived ? t("room.archivedBadge") : null}
        lines={
          <ProfileLine>
            {archived ? t("room.archivedLine") : plural("room.memberCount", members.length)}
          </ProfileLine>
        }
      >
        {!archived && (
          <Button
            variant="secondary"
            label={t("room.edit", { name })}
            onPress={() =>
              navigation.navigate("roomForm", { form: { _tag: "edit", roomId: room.id } })
            }
          />
        )}
      </Profile>

      {stopping === "force" && (
        // The operator confirmed the Stop already: Force stop goes at once.
        <StopRow
          label={t("room.forceStop")}
          why={t("room.forceStop.why", { name })}
          onPress={() => stopFocus.stopped(actions.forceStop(room))}
        />
      )}
      {(stopping === "offered" || stopping === "stopping") && (
        <StopRow
          label={stopping === "stopping" ? t("room.stopping") : t("room.stop")}
          onPress={
            stopping === "stopping"
              ? null
              : () =>
                  confirm({
                    title: t("room.stop.title", { name }),
                    body: t("room.stop.body", { name }),
                    cancel: t("room.stop.cancel"),
                    confirm: t("room.stop"),
                    onConfirm: () => stopFocus.stopped(actions.stop(room)),
                  })
          }
        />
      )}

      {room.hidden && <HiddenNotice name={name} onShow={() => placing.unhide(room)} />}

      <Section open title={t("room.membersTitle")}>
        {members.length === 0 ? (
          <Quiet>{t("room.noMembers")}</Quiet>
        ) : (
          members.map((bot) => (
            <View key={bot.id} className="min-h-12 flex-row items-center gap-3">
              <LiveBotAvatar bot={bot} size={32} />
              <View className="min-w-0 flex-1">
                <Text numberOfLines={1} className="text-base font-medium text-foreground">
                  {bot.profile.name}
                </Text>
                {bot.profile.title !== "" && (
                  <Text numberOfLines={1} className="text-xs text-muted-foreground">
                    {bot.profile.title}
                  </Text>
                )}
              </View>
            </View>
          ))
        )}
      </Section>

      <Section open title={t("room.archiveSection")}>
        <View className="items-start gap-3">
          {archived ? (
            <PendingButton
              label={t("room.unarchive", { name })}
              onPress={() => actions.unarchive(room)}
            />
          ) : (
            <>
              <Quiet>{t("room.archive.hint")}</Quiet>
              <PendingButton
                label={t("room.archive", { name })}
                onPress={() => actions.archive(room)}
              />
            </>
          )}
        </View>
      </Section>

      {/* Last and on its own, so the one action that cannot be undone is never next to another. */}
      <Apart>
        <DeleteButton
          label={t("room.delete", { name })}
          title={t("room.delete.title", { name })}
          body={t("room.delete.body", { name })}
          cancel={t("room.delete.cancel", { name })}
          onDelete={() => actions.remove(room)}
        />
      </Apart>
    </ScrollView>
  );
}
