// SPDX-License-Identifier: AGPL-3.0-or-later
import { rosterKeyOf, rosterKeyText } from "@j3-bots/client-runtime/presentation";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { useEffect } from "react";
import { View } from "react-native";
import { Connecting } from "../components/ConnectionLine.tsx";
import { ConversationView, Gone } from "../conversation/ConversationView.tsx";
import { useSideBySide } from "../layout.ts";
import { asItWas, type Screens, useOpenConversation } from "../navigation.tsx";
import { useRosterItem } from "./rosterItem.ts";

type Props = NativeStackScreenProps<Screens, "conversation">;

/**
 * A bot's or room's conversation on its own screen, on a phone. Unfolded to
 * the tablet width, it moves beside the roster, and what was open over it
 * stays open.
 */
export function ConversationScreen({ navigation, route }: Props) {
  const key = route.params.item;
  const found = useRosterItem(key);
  const sideBySide = useSideBySide();
  const openConversation = useOpenConversation();
  useEffect(() => {
    if (!sideBySide) return;
    const { routes } = navigation.getState();
    // Only the uppermost conversation moves; the ones under it close.
    const at = routes.findLastIndex((each) => each.name === "conversation");
    const roster = routes[0];
    if (roster === undefined || routes[at]?.key !== route.key) return;
    const above = routes.slice(at + 1).map(asItWas);
    navigation.reset({
      index: above.length,
      routes: [{ key: roster.key, name: "roster", params: { item: key } }, ...above],
    });
  }, [sideBySide, navigation, route.key, key]);
  // Arrived from the first run: once in place, the screen goes back to sliding like the others.
  const arriving = route.params.arriving === true;
  useEffect(() => {
    if (!arriving) return;
    return navigation.addListener("transitionEnd", () =>
      navigation.setParams({ arriving: undefined }),
    );
  }, [arriving, navigation]);
  if (found._tag === "loading") return <Connecting />;
  if (found._tag === "gone") {
    return (
      <View className="flex-1 bg-background">
        <Gone onBack={() => navigation.popTo("roster")} />
      </View>
    );
  }
  return (
    <ConversationView
      key={rosterKeyText(rosterKeyOf(found.item))}
      item={found.item}
      onBack={navigation.goBack}
      onOpenDetails={() => navigation.navigate("details", { item: key })}
      onOpen={openConversation}
      onGone={() => navigation.popTo("roster")}
    />
  );
}
