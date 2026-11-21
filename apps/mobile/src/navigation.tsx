// SPDX-License-Identifier: AGPL-3.0-or-later
import type { J3Client } from "@j3-bots/client-runtime";
import { useJ3Client } from "@j3-bots/client-runtime/react";
import type { RosterItemKey } from "@j3-bots/contracts";
import {
  DarkTheme,
  DefaultTheme,
  NavigationContainer,
  type NavigationState,
  type Theme,
  useNavigation,
} from "@react-navigation/native";
import {
  createNativeStackNavigator,
  type NativeStackNavigationProp,
} from "@react-navigation/native-stack";
import { useColorScheme } from "react-native";
import { KeyboardProvider } from "react-native-keyboard-controller";
import { useI18n } from "./i18n.ts";
import { useSideBySide } from "./layout.ts";
import { PresentationProvider } from "./presentation.tsx";
import { ConversationScreen } from "./screens/Conversation.tsx";
import { DetailsScreen } from "./screens/Details.tsx";
import { RosterScreen } from "./screens/Roster.tsx";
import { useColor } from "./theme.ts";
import { Toasts } from "./toast.tsx";

/**
 * One route per screen. On a phone they stack: the roster, a bot's or room's
 * conversation, its details. From the tablet width up the roster's route
 * shows the conversation `item` names beside the roster, and the
 * conversation's route is not used. Each route after the roster names the
 * bot or room by its roster key, so it shows the roster's current name.
 */
export type Screens = {
  roster: { readonly item?: RosterItemKey | undefined } | undefined;
  conversation: { readonly item: RosterItemKey };
  details: { readonly item: RosterItemKey };
};

type Navigation = NativeStackNavigationProp<Screens>;

const Stack = createNativeStackNavigator<Screens>();

/**
 * Opens a bot's or room's conversation where this layout shows one: on its
 * own screen on a phone, over the one shown now, or beside the roster.
 */
export function useOpenConversation(): (item: RosterItemKey) => void {
  const navigation = useNavigation<Navigation>();
  const sideBySide = useSideBySide();
  return (item) =>
    sideBySide ? navigation.popTo("roster", { item }) : navigation.push("conversation", { item });
}

/** The navigation theme in the tokens' colors, over React Navigation's own for the system's scheme. */
function useNavigationTheme(): Theme {
  const base = useColorScheme() === "dark" ? DarkTheme : DefaultTheme;
  const background = useColor("accent-background");
  const foreground = useColor("accent-foreground");
  const border = useColor("accent-border");
  const accent = useColor("accent-accent");
  return {
    ...base,
    colors: {
      ...base.colors,
      background,
      card: background,
      text: foreground,
      border,
      primary: accent,
      notification: accent,
    },
  };
}

/**
 * Where each client's navigation stands, for as long as the app runs. Android
 * rebuilds the app's view when the window's density changes, as when a
 * foldable folds or unfolds, and the screens mount again; they pick up from
 * here rather than start over at the roster. Another server has another
 * client, so it starts at the roster.
 */
const kept = new WeakMap<J3Client, NavigationState>();

/** What a paired device shows. */
export function Main() {
  const { t } = useI18n();
  const client = useJ3Client();
  const theme = useNavigationTheme();
  const resumed = kept.get(client);
  return (
    <KeyboardProvider>
      <PresentationProvider>
        <Toasts>
          <NavigationContainer
            theme={theme}
            {...(resumed === undefined ? {} : { initialState: resumed })}
            onStateChange={(state) => {
              if (state === undefined) kept.delete(client);
              else kept.set(client, state);
            }}
          >
            <Stack.Navigator>
              {/* The roster and the conversation draw their own headers, which hold more than a title. */}
              <Stack.Screen
                name="roster"
                component={RosterScreen}
                options={{ title: t("roster.label"), headerShown: false }}
              />
              <Stack.Screen
                name="conversation"
                component={ConversationScreen}
                options={{ headerShown: false }}
              />
              <Stack.Screen name="details" component={DetailsScreen} />
            </Stack.Navigator>
          </NavigationContainer>
        </Toasts>
      </PresentationProvider>
    </KeyboardProvider>
  );
}
