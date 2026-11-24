// SPDX-License-Identifier: AGPL-3.0-or-later
import { pairOrder, pairTitle } from "@j3-bots/client-runtime/wording";
import type { PairBotIds } from "@j3-bots/contracts";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { ChevronLeft, EllipsisVertical } from "lucide-react-native";
import { type ComponentRef, useRef, useState } from "react";
import { Pressable, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { AvatarStack } from "../components/avatar/BotAvatar.tsx";
import { Icon } from "../components/Icon.tsx";
import { Menu, type MenuAnchor } from "../components/Menu.tsx";
import { PairView } from "../conversation/PairView.tsx";
import type { Screens } from "../navigation.tsx";
import { useBots, usePresentation } from "../presentation.tsx";
import { Text } from "../text.tsx";
import { usePairMenu } from "./pairMenu.ts";

type Props = NativeStackScreenProps<Screens, "pair">;

/**
 * The teammate conversation of two bots, on its own screen: read here, never
 * written to. Its header names both, and its menu leads to each bot's own
 * conversation and to a room with both.
 */
export function PairScreen({ navigation, route }: Props) {
  const { botIds, at } = route.params;
  return (
    <View className="flex-1 bg-background">
      <PairHeader botIds={botIds} onBack={navigation.goBack} />
      <PairView botIds={botIds} at={at} />
    </View>
  );
}

/** Both bots' faces side by side, their names, and the menu. */
function PairHeader({
  botIds,
  onBack,
}: {
  readonly botIds: PairBotIds;
  readonly onBack: () => void;
}) {
  const ctx = usePresentation();
  const { t } = ctx.i18n;
  const insets = useSafeAreaInsets();
  const bots = useBots();
  const title = pairTitle(botIds, ctx);
  const members = pairOrder(botIds, ctx).flatMap((id) => {
    const bot = bots.get(id);
    return bot === undefined ? [] : [{ id, avatar: bot.profile.avatar }];
  });
  const entries = usePairMenu(botIds);
  const button = useRef<ComponentRef<typeof Pressable>>(null);
  const [menuAt, setMenuAt] = useState<MenuAnchor | null>(null);
  const menuLabel = t("roster.menu", { name: title });
  return (
    <View style={{ paddingTop: insets.top }}>
      <View className="min-h-12 flex-row items-center gap-1 border-b border-border px-2">
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t("pairs.back")}
          onPress={onBack}
          className="size-11 items-center justify-center"
        >
          <Icon icon={ChevronLeft} size={20} color="accent-foreground" />
        </Pressable>
        <View className="min-w-0 flex-1 flex-row items-center gap-2 px-1.5">
          <AvatarStack size={28} members={members} />
          <Text
            accessibilityRole="header"
            numberOfLines={1}
            className="min-w-0 shrink text-base font-medium text-foreground"
          >
            {title}
          </Text>
        </View>
        {entries.length > 0 && (
          <Pressable
            ref={button}
            accessibilityRole="button"
            accessibilityLabel={menuLabel}
            onPress={() =>
              button.current?.measureInWindow((x, y, width, height) =>
                setMenuAt({ x, y, width, height }),
              )
            }
            className="size-11 items-center justify-center rounded-pill active:bg-muted"
          >
            <Icon icon={EllipsisVertical} size={20} color="accent-foreground" />
          </Pressable>
        )}
      </View>
      <Menu anchor={menuAt} onClose={() => setMenuAt(null)} label={menuLabel} entries={entries} />
    </View>
  );
}
