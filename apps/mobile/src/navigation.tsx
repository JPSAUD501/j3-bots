// SPDX-License-Identifier: AGPL-3.0-or-later
import type {
  BotId,
  BrowserTabRef,
  ConnectorGlyph,
  ConnectorId,
  CredentialId,
  EntryId,
  ListingRef,
  MemoryPath,
  PairBotIds,
  RoomId,
  RosterItemKey,
  RoutineId,
} from "@j3-bots/contracts";
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
import { AddConnectorScreen } from "./connectors/AddConnectorScreen.tsx";
import { ConnectorScreen } from "./connectors/ConnectorScreen.tsx";
import { ConnectorsScreen } from "./connectors/ConnectorsScreen.tsx";
import { ListingScreen } from "./connectors/ListingScreen.tsx";
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
import { RosterScreen } from "./screens/Roster.tsx";
import { ShareOpener, ShareScreen } from "./share/SharePicker.tsx";
import { NewFromTemplateScreen, ShareTemplateScreen, TemplateOpener } from "./template/screens.tsx";
import { BrowserScreen } from "./browser/BrowserScreen.tsx";
import { useColor } from "./theme.ts";
import { CredentialFormScreen } from "./vault/CredentialFormScreen.tsx";
import { CredentialScreen } from "./vault/CredentialScreen.tsx";
import { VaultScreen } from "./vault/VaultScreen.tsx";
import { Toasts } from "./toast.tsx";
import { FileOpenerProvider } from "./conversation/FileOpener.tsx";
import { FlightHost } from "./onboarding/handoff.tsx";

/**
 * One route per screen. On a phone they stack: the roster, a bot's or room's
 * conversation, its details, a teammate conversation, and over those the
 * forms, a memory file and a routine's runs;
 * Settings and the hidden bots open from the roster. From the tablet width up the roster's route
 * shows the conversation `item` names beside the roster, and the
 * conversation's route is not used. Each route after the roster names the
 * bot or room by its roster key, so it shows the roster's current name.
 * `share` picks where something another app shared goes, over the rest.
 * `shareTemplate` shows a bot as a template before it is shared, and
 * `newFromTemplate` the template file opened, before a bot is made from it.
 * The vault's saved logins open from Settings, then one login, then its form.
 * The connectors' screens open from Settings, a bot's details and a card:
 * their list and the gallery, a gallery entry, one connector, and adding one
 * of the operator's own. `forBot` is the bot a new connector is for at first,
 * and `suggestion` the card that suggested it.
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
  share: undefined;
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
  /** `section` scrolls to one section, as the roster's update notice does. */
  settings: { readonly section?: "updates" } | undefined;
  hidden: undefined;
  vault: undefined;
  credential: { readonly id: CredentialId };
  /** A new login with `id` null; otherwise the one to change. */
  credentialForm: { readonly id: CredentialId | null };
  connectors: { readonly forBot: BotId | null; readonly suggestion: EntryId | null } | undefined;
  connectorListing: {
    readonly ref: ListingRef;
    readonly name: string;
    readonly glyph: ConnectorGlyph | null;
    readonly forBot: BotId | null;
    readonly suggestion: EntryId | null;
  };
  connector: {
    readonly connectorId: ConnectorId;
    /** Start its sign-in as the screen opens, as a card's Sign in asks. */
    readonly signIn: boolean;
    /** It was just added: the screen says who can use it from now. */
    readonly added: boolean;
  };
  addConnector: { readonly forBot: BotId | null };
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
  const { t } = useI18n();
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
                <Stack.Screen
                  name="share"
                  component={ShareScreen}
                  options={{ title: t("share.title"), presentation: "modal" }}
                />
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
                {/* The vault's screens set their own titles. */}
                <Stack.Screen name="vault" component={VaultScreen} />
                <Stack.Screen name="credential" component={CredentialScreen} />
                <Stack.Screen
                  name="credentialForm"
                  options={sheet}
                  component={CredentialFormScreen}
                />
                {/* The connectors' screens set their own titles. */}
                <Stack.Screen name="connectors" component={ConnectorsScreen} />
                <Stack.Screen name="connectorListing" component={ListingScreen} />
                <Stack.Screen name="connector" component={ConnectorScreen} />
                <Stack.Screen name="addConnector" options={sheet} component={AddConnectorScreen} />
              </Stack.Navigator>
            </NavigationContainer>
          </FileOpenerProvider>
          <FlightHost />
          <ShareOpener navigation={navigation} ready={ready} />
          <TemplateOpener navigation={navigation} ready={ready} />
        </Toasts>
      </PresentationProvider>
    </KeyboardProvider>
  );
}
