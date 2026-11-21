// SPDX-License-Identifier: AGPL-3.0-or-later
import type { J3Client } from "@j3-bots/client-runtime";
import { useJ3Client } from "@j3-bots/client-runtime/react";
import type { BotId, MemoryPath, RoomId, RosterItemKey } from "@j3-bots/contracts";
import {
  DarkTheme,
  DefaultTheme,
  NavigationContainer,
  type NavigationRoute,
  type NavigationState,
  type Theme,
  useNavigation,
  useNavigationContainerRef,
} from "@react-navigation/native";
import {
  createNativeStackNavigator,
  type NativeStackNavigationProp,
} from "@react-navigation/native-stack";
import { useState } from "react";
import { useColorScheme } from "react-native";
import { KeyboardProvider } from "react-native-keyboard-controller";
import { useI18n } from "./i18n.ts";
import { useSideBySide } from "./layout.ts";
import { PresentationProvider } from "./presentation.tsx";
import { ConversationScreen } from "./screens/Conversation.tsx";
import { DetailsScreen } from "./screens/Details.tsx";
import { EditBotScreen } from "./screens/EditBot.tsx";
import { MemoryFileScreen } from "./screens/MemoryFile.tsx";
import { NewBotScreen } from "./screens/NewBot.tsx";
import { RoomFormScreen } from "./screens/RoomForm.tsx";
import { RosterScreen } from "./screens/Roster.tsx";
import { ShareOpener, ShareScreen } from "./share/SharePicker.tsx";
import { useColor } from "./theme.ts";
import { Toasts } from "./toast.tsx";

/**
 * One route per screen. On a phone they stack: the roster, a bot's or room's
 * conversation, its details, and over those the forms and a memory file. From the tablet width up the roster's route
 * shows the conversation `item` names beside the roster, and the
 * conversation's route is not used. Each route after the roster names the
 * bot or room by its roster key, so it shows the roster's current name.
 * `share` picks where something another app shared goes, over the rest.
 */
export type Screens = {
  roster: { readonly item?: RosterItemKey | undefined } | undefined;
  conversation: { readonly item: RosterItemKey };
  details: { readonly item: RosterItemKey };
  share: undefined;
  editBot: { readonly botId: BotId };
  memoryFile: { readonly botId: BotId; readonly path: MemoryPath };
  roomForm: { readonly form: RoomFormFor };
  newBot: undefined;
};

/**
 * What the room form is open for: a new room, or one the roster has, named by
 * id, to edit or to give what it needs to take messages again.
 */
type RoomFormFor =
  | { readonly _tag: "create" }
  | { readonly _tag: "edit" | "unarchive"; readonly roomId: RoomId };

export type Navigation = NativeStackNavigationProp<Screens>;

/**
 * A route as `reset` takes it back, as it was: which screen and what it
 * shows. No screen holds a navigator of its own, so there is no state under it.
 */
export const asItWas = ({ key, name, params }: NavigationRoute<Screens, keyof Screens>) => ({
  key,
  name,
  params,
});

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

/**
 * Opens a bot's or room's conversation in place of the screen that asks, as
 * a form does once it has created the bot or room.
 */
export function useReplaceWithConversation(): (item: RosterItemKey) => void {
  const navigation = useNavigation<Navigation>();
  const sideBySide = useSideBySide();
  return (item) =>
    sideBySide
      ? navigation.popTo("roster", { item })
      : navigation.replace("conversation", { item });
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
  const navigation = useNavigationContainerRef<Screens>();
  const [ready, setReady] = useState(false);
  return (
    <KeyboardProvider>
      <PresentationProvider>
        <Toasts>
          <NavigationContainer
            ref={navigation}
            onReady={() => setReady(true)}
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
              <Stack.Screen
                name="share"
                component={ShareScreen}
                options={{ title: t("share.title"), presentation: "modal" }}
              />
              {/* The forms and the memory file set their own titles, which name what they change. */}
              <Stack.Screen name="editBot" component={EditBotScreen} />
              <Stack.Screen name="memoryFile" component={MemoryFileScreen} />
              <Stack.Screen name="roomForm" component={RoomFormScreen} />
              <Stack.Screen
                name="newBot"
                component={NewBotScreen}
                options={{ title: t("newBot.title") }}
              />
            </Stack.Navigator>
          </NavigationContainer>
          <ShareOpener navigation={navigation} ready={ready} />
        </Toasts>
      </PresentationProvider>
    </KeyboardProvider>
  );
}
