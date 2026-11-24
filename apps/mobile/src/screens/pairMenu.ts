// SPDX-License-Identifier: AGPL-3.0-or-later
import { pairOrder } from "@j3-bots/client-runtime/wording";
import type { PairBotIds } from "@j3-bots/contracts";
import { useNavigation } from "@react-navigation/native";
import { MessageCircle, Users } from "lucide-react-native";
import type { MenuEntry } from "../components/Menu.tsx";
import { type Navigation, useOpenConversation } from "../navigation.tsx";
import { useBots, usePresentation } from "../presentation.tsx";

/**
 * What a teammate conversation offers, from its header or its roster row:
 * talking to either bot in its own conversation, by name, and starting a
 * room with both, the form open with the two picked. A deleted bot offers
 * neither its conversation nor the room. No pair offers nothing.
 */
export function usePairMenu(botIds: PairBotIds | null): ReadonlyArray<MenuEntry> {
  const ctx = usePresentation();
  const { t } = ctx.i18n;
  const bots = useBots();
  const navigation = useNavigation<Navigation>();
  const openConversation = useOpenConversation();
  if (botIds === null) return [];
  // In the order the title names them.
  const both = pairOrder(botIds, ctx).flatMap((id) => {
    const bot = bots.get(id);
    return bot === undefined ? [] : [bot];
  });
  const talk = both.map((bot): MenuEntry => ({
    key: bot.id,
    label: t("pairs.talkTo", { name: bot.profile.name }),
    icon: MessageCircle,
    onPress: () => openConversation({ _tag: "bot", botId: bot.id }),
  }));
  return both.length < 2
    ? talk
    : [
        ...talk,
        {
          label: t("pairs.startRoom"),
          icon: Users,
          onPress: () =>
            navigation.navigate("roomForm", {
              form: { _tag: "create", members: both.map((bot) => bot.id) },
            }),
        },
      ];
}
