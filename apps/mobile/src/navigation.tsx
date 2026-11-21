// SPDX-License-Identifier: AGPL-3.0-or-later
import type { RosterItemKey } from "@j3-bots/contracts";
import { DarkTheme, DefaultTheme, NavigationContainer, type Theme } from "@react-navigation/native";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import { useColorScheme } from "react-native";
import { useCSSVariable } from "uniwind";
import { useI18n } from "./i18n.ts";
import { ConversationScreen, conversationOptions } from "./screens/Conversation.tsx";
import { DetailsScreen } from "./screens/Details.tsx";
import { RosterScreen } from "./screens/Roster.tsx";

/**
 * The three regions, as a stack on a phone: the roster, a bot's or room's
 * conversation, and its details. Each region after the roster names the bot or
 * room by its roster key, so it shows the roster's current name.
 */
export type Screens = {
  roster: undefined;
  conversation: { readonly item: RosterItemKey };
  details: { readonly item: RosterItemKey };
};

const Stack = createNativeStackNavigator<Screens>();

/** The navigation theme in the tokens' colors, over React Navigation's own for the system's scheme. */
function useNavigationTheme(): Theme {
  const base = useColorScheme() === "dark" ? DarkTheme : DefaultTheme;
  const [background, foreground, border, accent] = useCSSVariable([
    "--color-background",
    "--color-foreground",
    "--color-border",
    "--color-accent",
  ]);
  const color = (value: string | number | undefined, otherwise: string) =>
    typeof value === "string" ? value : otherwise;
  return {
    ...base,
    colors: {
      ...base.colors,
      background: color(background, base.colors.background),
      card: color(background, base.colors.card),
      text: color(foreground, base.colors.text),
      border: color(border, base.colors.border),
      primary: color(accent, base.colors.primary),
      notification: color(accent, base.colors.notification),
    },
  };
}

/** What a paired phone shows. */
export function Main() {
  const { t } = useI18n();
  const theme = useNavigationTheme();
  return (
    <NavigationContainer theme={theme}>
      <Stack.Navigator>
        <Stack.Screen
          name="roster"
          component={RosterScreen}
          options={{ title: t("roster.label") }}
        />
        <Stack.Screen
          name="conversation"
          component={ConversationScreen}
          options={conversationOptions}
        />
        <Stack.Screen name="details" component={DetailsScreen} />
      </Stack.Navigator>
    </NavigationContainer>
  );
}
