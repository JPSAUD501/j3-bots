// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Room } from "@j3-bots/contracts";
import { useNavigation } from "@react-navigation/native";
import { ScrollView, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { BotAvatar } from "../components/Avatar.tsx";
import { confirm, PendingButton, Quiet, Section } from "../components/form.tsx";
import { useI18n } from "../i18n.ts";
import type { Navigation } from "../navigation.tsx";
import { useBots } from "../presentation.tsx";
import { Button } from "../ui.tsx";
import { useRoomActions } from "./actions.ts";

/**
 * A room's details: who is in it, who hosts, how long bots may talk among
 * themselves, and what the operator does to the room itself.
 */
export function RoomDetails({ room }: { readonly room: Room }) {
  const { t, plural } = useI18n();
  const insets = useSafeAreaInsets();
  const navigation = useNavigation<Navigation>();
  const bots = useBots();
  const actions = useRoomActions();
  const { name } = room;
  const archived = room.status === "archived";
  const members = room.members.flatMap((id) => {
    const bot = bots.get(id);
    return bot === undefined ? [] : [bot];
  });
  return (
    <ScrollView
      className="flex-1 bg-background"
      contentContainerStyle={{ paddingBottom: insets.bottom + 16 }}
    >
      <Section>
        {archived ? (
          <Quiet>{t("room.archivedLine")}</Quiet>
        ) : (
          <View className="items-start">
            <Button
              label={t("room.edit", { name })}
              onPress={() =>
                navigation.navigate("roomForm", { form: { _tag: "edit", roomId: room.id } })
              }
            />
          </View>
        )}
      </Section>

      <Section title={t("room.membersTitle")}>
        {members.length === 0 ? (
          <Quiet>{t("room.noMembers")}</Quiet>
        ) : (
          members.map((bot) => (
            <View key={bot.id} className="min-h-9 flex-row items-center gap-2.5">
              <BotAvatar avatar={bot.profile.avatar} state={bot.state} size={28} />
              <View className="min-w-0 flex-1">
                <Text numberOfLines={1} className="text-base text-foreground">
                  {bot.profile.name}
                </Text>
                {bot.profile.title !== "" && (
                  <Text numberOfLines={1} className="text-xs text-muted-foreground">
                    {bot.profile.title}
                  </Text>
                )}
              </View>
              {bot.id === room.hostId && (
                <Text className="rounded-sm bg-muted px-1.5 py-0.5 text-2xs text-muted-foreground">
                  {t("room.host")}
                </Text>
              )}
            </View>
          ))
        )}
      </Section>

      <Section title={t("room.budget")}>
        <Text className="text-sm text-foreground">{plural("room.hopLimit", room.hopLimit)}</Text>
      </Section>

      <Section>
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
      <View className="items-start px-4 py-4">
        <Button
          variant="destructive"
          label={t("room.delete", { name })}
          onPress={() =>
            confirm({
              title: t("room.delete.title", { name }),
              body: t("room.delete.body", { name }),
              cancel: t("room.delete.cancel", { name }),
              confirm: t("room.delete", { name }),
              onConfirm: () => actions.remove(room),
            })
          }
        />
      </View>
    </ScrollView>
  );
}
