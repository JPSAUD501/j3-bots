// SPDX-License-Identifier: AGPL-3.0-or-later
import type { BotId, MemoryPath, RoomId, RosterItemKey, RoutineId } from "@j3-bots/contracts";
import { rosterKeyText } from "@j3-bots/client-runtime/presentation";
import { fontFamilies } from "@j3-bots/design-tokens";
import {
  DarkTheme,
  DefaultTheme,
  NavigationContainer,
  type NavigationRoute,
  type Theme,
  useNavigation,
  useNavigationContainerRef,
} from "@react-navigation/native";
import {
  createNativeStackNavigator,
  type NativeStackNavigationProp,
  type NativeStackNavigationOptions,
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
import { RoutineRunsScreen } from "./screens/RoutineRuns.tsx";
import { SettingsScreen } from "./settings/Settings.tsx";
import { RosterScreen } from "./screens/Roster.tsx";
import { ShareOpener, ShareScreen } from "./share/SharePicker.tsx";
import { NewFromTemplateScreen, ShareTemplateScreen, TemplateOpener } from "./template/screens.tsx";
import { useColor } from "./theme.ts";
import { Toasts } from "./toast.tsx";

/**
 * One route per screen. On a phone they stack: the roster, a bot's or room's
 * conversation, its details, and over those the forms, a memory file and a
 * routine's runs;
 * Settings opens from the roster. From the tablet width up the roster's route
 * shows the conversation `item` names beside the roster, and the
 * conversation's route is not used. Each route after the roster names the
 * bot or room by its roster key, so it shows the roster's current name.
 * `share` picks where something another app shared goes, over the rest.
 * `shareTemplate` shows a bot as a template before it is shared, and
 * `newFromTemplate` the template file opened, before a bot is made from it.
 */
export type Screens = {
  roster: { readonly item?: RosterItemKey | undefined } | undefined;
  conversation: { readonly item: RosterItemKey };
  details: { readonly item: RosterItemKey };
  share: undefined;
  shareTemplate: { readonly botId: BotId };
  newFromTemplate: undefined;
  editBot: { readonly botId: BotId };
  memoryFile: { readonly botId: BotId; readonly path: MemoryPath };
  routineRuns: { readonly botId: BotId; readonly routineId: RoutineId };
  roomForm: { readonly form: RoomFormFor };
  newBot: undefined;
  settings: undefined;
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
 * own screen on a phone, over the one shown now unless that is it already,
 * or beside the roster.
 */
export function useOpenConversation(): (item: RosterItemKey) => void {
  const navigation = useNavigation<Navigation>();
  const sideBySide = useSideBySide();
  return (item) => {
    if (sideBySide) {
      navigation.popTo("roster", { item });
      return;
    }
    const { routes, index } = navigation.getState();
    const shown = routes[index];
    // A route's params are not told apart by its name: the conversation's are those with an item.
    const params = shown?.name === "conversation" ? shown.params : undefined;
    const shownItem = params !== undefined && "item" in params ? params.item : undefined;
    if (shownItem === undefined || rosterKeyText(shownItem) !== rosterKeyText(item)) {
      navigation.push("conversation", { item });
    }
  };
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
 * Every screen's header in the display face, flat on the canvas. A screen
 * pushed from another slides in over it as the one under it drifts back; one
 * that is a task of its own (a form, Settings, a routine's runs) rises from the
 * bottom like a sheet.
 */
const screenOptions = {
  headerTitleStyle: { fontFamily: fontFamilies.display, fontWeight: "700" },
  headerShadowVisible: false,
  animation: "ios_from_right",
} as const satisfies NativeStackNavigationOptions;

const sheet = { animation: "slide_from_bottom" } as const satisfies NativeStackNavigationOptions;

/** What a paired device shows. */
export function Main() {
  const { t } = useI18n();
  const theme = useNavigationTheme();
  const navigation = useNavigationContainerRef<Screens>();
  const [ready, setReady] = useState(false);
  return (
    <KeyboardProvider>
      <PresentationProvider>
        <Toasts>
          <NavigationContainer ref={navigation} onReady={() => setReady(true)} theme={theme}>
            <Stack.Navigator screenOptions={screenOptions}>
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
              {/* The forms, the memory file and a routine's runs set their own titles. */}
              <Stack.Screen name="editBot" options={sheet} component={EditBotScreen} />
              <Stack.Screen name="memoryFile" options={sheet} component={MemoryFileScreen} />
              <Stack.Screen name="routineRuns" options={sheet} component={RoutineRunsScreen} />
              <Stack.Screen name="roomForm" options={sheet} component={RoomFormScreen} />
              <Stack.Screen
                name="newBot"
                component={NewBotScreen}
                options={{ ...sheet, title: t("newBot.title") }}
              />
              <Stack.Screen name="shareTemplate" options={sheet} component={ShareTemplateScreen} />
              <Stack.Screen
                name="newFromTemplate"
                component={NewFromTemplateScreen}
                options={{ ...sheet, title: t("template.create.title") }}
              />
              <Stack.Screen
                name="settings"
                component={SettingsScreen}
                options={{ ...sheet, title: t("settings.title") }}
              />
            </Stack.Navigator>
          </NavigationContainer>
          <ShareOpener navigation={navigation} ready={ready} />
          <TemplateOpener navigation={navigation} ready={ready} />
        </Toasts>
      </PresentationProvider>
    </KeyboardProvider>
  );
}
