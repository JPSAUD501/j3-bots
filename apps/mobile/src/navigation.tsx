// SPDX-License-Identifier: AGPL-3.0-or-later
import type {
  BotId,
  BrowserTabRef,
  ConnectorId,
  EntryId,
  MemoryPath,
  PairBotIds,
  RoomId,
  RosterItemKey,
  RoutineId,
  SecretId,
  SkillName,
  SkillScope,
} from "@j3-bots/contracts";
import { rosterKeyText, type SettingsPage } from "@j3-bots/client-runtime/presentation";
import { settingsPageWords } from "@j3-bots/client-runtime/wording";
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
import { ConnectorScreen } from "./connectors/ConnectorScreen.tsx";
import { ConnectorsScreen } from "./connectors/ConnectorsScreen.tsx";
import { SkillScreen } from "./connectors/Skills.tsx";
import { useI18n } from "./i18n.ts";
import { useSideBySide } from "./layout.ts";
import { PresentationProvider } from "./presentation.tsx";
import { ConversationScreen } from "./screens/Conversation.tsx";
import { DetailsScreen } from "./screens/Details.tsx";
import { EditBotScreen } from "./screens/EditBot.tsx";
import { HiddenScreen } from "./screens/Hidden.tsx";
import { MemoryFileScreen } from "./screens/MemoryFile.tsx";
import { NewBotScreen } from "./screens/NewBot.tsx";
import { PairScreen } from "./screens/Pair.tsx";
import { RoomFormScreen } from "./screens/RoomForm.tsx";
import { RoutineRunsScreen } from "./screens/RoutineRuns.tsx";
import { SettingsScreen } from "./settings/Settings.tsx";
import { SettingsPageScreen } from "./settings/SettingsPage.tsx";
import { WhatsNewScreen } from "./update/WhatsNew.tsx";
import { RosterScreen } from "./screens/Roster.tsx";
import { NewFromTemplateScreen, ShareTemplateScreen, TemplateOpener } from "./template/screens.tsx";
import { BrowserScreen } from "./browser/BrowserScreen.tsx";
import { useColor } from "./theme.ts";
import { SecretFormScreen } from "./secrets/SecretFormScreen.tsx";
import { SecretScreen } from "./secrets/SecretScreen.tsx";
import { SecretsScreen } from "./secrets/SecretsScreen.tsx";
import { Toasts } from "./toast.tsx";
import { FileOpenerProvider } from "./conversation/FileOpener.tsx";
import { FlightHost } from "./onboarding/handoff.tsx";

/**
 * One route per screen. On a phone they stack: the roster, a bot's or room's
 * conversation, its details, a teammate conversation, and over those the
 * forms, a memory file and a routine's runs;
 * Settings and the hidden conversations open from the roster. From the
 * tablet width up the roster's route shows the conversation `item` names
 * beside the roster, and the conversation's route is not used. Each route after the roster names the
 * bot or room by its roster key, so it shows the roster's current name.
 * `shareTemplate` shows a bot as a template before it is shared, and
 * `newFromTemplate` the template file opened, before a bot is made from it.
 * The operator's secrets open from Settings and from a connector that cannot
 * read them, then one secret, then its form.
 * The connectors' screens open from Settings, a bot's details and a card:
 * their list, and one connector. The skills open from the same list.
 */
export type Screens = {
  roster: { readonly item?: RosterItemKey | undefined } | undefined;
  /** `arriving` while the first bot travels in from the first run: the screen fades in, holding still. */
  conversation: { readonly item: RosterItemKey; readonly arriving?: true | undefined };
  details: { readonly item: RosterItemKey };
  /**
   * The teammate conversation of two bots, read-only, opened at its latest
   * message or, with `at`, at the message one of whose cards that entry is.
   */
  pair: { readonly botIds: PairBotIds; readonly at?: EntryId };
  shareTemplate: { readonly botId: BotId };
  newFromTemplate: undefined;
  editBot: { readonly botId: BotId };
  memoryFile: { readonly botId: BotId; readonly path: MemoryPath };
  routineRuns: { readonly botId: BotId; readonly routineId: RoutineId };
  /**
   * The bot's browser, on the tab `ref` names or its front tab, answering the
   * browser help card `help` once the operator is done.
   */
  browser: { readonly botId: BotId; readonly ref?: BrowserTabRef; readonly help?: EntryId };
  roomForm: { readonly form: RoomFormFor };
  newBot: undefined;
  settings: undefined;
  settingsPage: { readonly page: SettingsPage };
  whatsNew: undefined;
  hidden: undefined;
  secrets: undefined;
  secret: { readonly id: SecretId };
  /** A new secret with `id` null; otherwise the one to change. */
  secretForm: { readonly id: SecretId | null };
  connectors: undefined;
  connector: {
    readonly connectorId: ConnectorId;
    /** Start its sign-in as the screen opens, as a card's Sign in asks. */
    readonly signIn: boolean;
  };
  /** One skill, by whose it is and its name. */
  skill: { readonly scope: SkillScope; readonly name: SkillName };
};

/**
 * What the room form is open for: a new room, with `members` picked already
 * when a teammate conversation starts one with its two bots, or one the
 * roster has, named by id, to edit or to give what it needs to take messages
 * again.
 */
type RoomFormFor =
  | { readonly _tag: "create"; readonly members?: ReadonlyArray<BotId> }
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
 * or beside the roster. `arriving` is for the first bot coming from the
 * first run, whose screen fades in rather than slides, so the bot can travel
 * into its header (`sendOff`).
 */
export function useOpenConversation(): (item: RosterItemKey, arriving?: boolean) => void {
  const navigation = useNavigation<Navigation>();
  const sideBySide = useSideBySide();
  return (item, arriving = false) => {
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
      navigation.push("conversation", arriving ? { item, arriving: true } : { item });
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
  const i18n = useI18n();
  const { t } = i18n;
  const theme = useNavigationTheme();
  const navigation = useNavigationContainerRef<Screens>();
  const [ready, setReady] = useState(false);
  return (
    <KeyboardProvider>
      <PresentationProvider>
        <Toasts>
          <FileOpenerProvider>
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
                  options={({ route }) => ({
                    headerShown: false,
                    ...(route.params.arriving === true ? { animation: "fade" } : {}),
                  })}
                />
                <Stack.Screen name="details" component={DetailsScreen} />
                {/* Draws its own header: both bots' faces, their names and its menu. */}
                <Stack.Screen name="pair" component={PairScreen} options={{ headerShown: false }} />
                {/* Sets its own title. */}
                <Stack.Screen name="hidden" component={HiddenScreen} />
                {/* The browser draws its own bar: the page's site and who acts on it. */}
                <Stack.Screen
                  name="browser"
                  component={BrowserScreen}
                  options={{ ...sheet, headerShown: false }}
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
                <Stack.Screen
                  name="shareTemplate"
                  options={sheet}
                  component={ShareTemplateScreen}
                />
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
                <Stack.Screen
                  name="settingsPage"
                  component={SettingsPageScreen}
                  options={({ route }) => ({
                    title: settingsPageWords(route.params.page, i18n).title,
                  })}
                />
                <Stack.Screen
                  name="whatsNew"
                  component={WhatsNewScreen}
                  options={{ title: t("whatsNew.title") }}
                />
                {/* The secrets' screens set their own titles. */}
                <Stack.Screen name="secrets" component={SecretsScreen} />
                <Stack.Screen name="secret" component={SecretScreen} />
                <Stack.Screen name="secretForm" options={sheet} component={SecretFormScreen} />
                {/* The connectors' screens set their own titles. */}
                <Stack.Screen name="connectors" component={ConnectorsScreen} />
                <Stack.Screen name="connector" component={ConnectorScreen} />
                <Stack.Screen name="skill" component={SkillScreen} />
              </Stack.Navigator>
            </NavigationContainer>
          </FileOpenerProvider>
          <FlightHost />
          <TemplateOpener navigation={navigation} ready={ready} />
        </Toasts>
      </PresentationProvider>
    </KeyboardProvider>
  );
}
