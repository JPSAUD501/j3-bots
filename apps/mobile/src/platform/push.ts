// SPDX-License-Identifier: AGPL-3.0-or-later
import type { J3Client } from "@j3-bots/client-runtime";
import {
  type DeviceId,
  type Language,
  NotificationKind,
  type PushPlatform,
  PushToken,
} from "@j3-bots/contracts";
import { createI18n, type KeyWith } from "@j3-bots/i18n";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import Constants from "expo-constants";
import * as Crypto from "expo-crypto";
import * as Notifications from "expo-notifications";
import { AppState, Linking, Platform } from "react-native";
import { shownLanguage, subscribePreferences } from "../preferences.ts";
import type { Session } from "../session.ts";

// Push notifications through Expo's push service (decision 0014): an Expo
// push token of this phone's own for each pairing, registered with the server
// it is paired with, in the language the app shows. The server pushes to a
// device with no socket open: this app in the background (`Lifecycle`), or in
// the foreground while it cannot reach the server. What a tap opens is
// `useNotificationTaps`.

/** What the operator decided about notifications on this phone, for Settings to show. */
export type NotificationAccess =
  /** This build cannot receive pushes: it was built without a push project, or not for a phone. */
  | "unavailable"
  /** Not asked yet: allowing them asks. */
  | "undecided"
  /** Refused; allowing them asks again. */
  | "denied"
  /** Refused for good: only the system's settings can allow them now. */
  | "blocked"
  | "granted";

/** Logs a failure no screen shows: notifications are a convenience, and the roster shows what arrived. */
export const logUnshown = (message: string, error: unknown) => {
  // @effect-diagnostics-next-line globalConsole:off
  console.warn(message, error);
};

const pushPlatform: PushPlatform | null =
  Platform.OS === "ios" || Platform.OS === "android" ? Platform.OS : null;

const EasExtra = Schema.Struct({ eas: Schema.Struct({ projectId: Schema.String }) });
const decodeEasExtra = Schema.decodeUnknownOption(EasExtra);

/** The EAS project whose push credentials Expo holds for this build, if it was built with one. */
const pushProject = (): string | null =>
  Constants.easConfig?.projectId ??
  Option.getOrNull(
    Option.map(decodeEasExtra(Constants.expoConfig?.extra), (extra) => extra.eas.projectId),
  );

const accessOf = (permission: Notifications.NotificationPermissionsStatus): NotificationAccess => {
  if (permission.granted) return "granted";
  if (permission.status === Notifications.PermissionStatus.UNDETERMINED) return "undecided";
  return permission.canAskAgain ? "denied" : "blocked";
};

/** What the operator decided about notifications on this phone, read afresh. */
export const readAccess = async (): Promise<NotificationAccess> =>
  pushPlatform === null || pushProject() === null
    ? "unavailable"
    : accessOf(await Notifications.getPermissionsAsync());

/** The name of the Android channel each kind of push shows in. */
const CHANNEL_NAMES = {
  message: "notification.channel.message",
  question: "notification.channel.question",
  approval: "notification.channel.approval",
  "secret-request": "notification.channel.secret",
  "browser-help": "notification.channel.browserHelp",
  connector: "notification.channel.connector",
} as const satisfies Record<NotificationKind, KeyWith>;

/**
 * A channel the app made for a kind of push no server sends any more, gone so
 * the system's settings don't list it.
 */
const RETIRED_CHANNEL = "handoff";

/**
 * Creates the Android channel each kind of push shows in, its id the kind the
 * server names (`NotificationKind`), so the operator can silence one kind
 * alone. One created before keeps what the operator chose for it and takes
 * its name in `language`.
 */
const createChannels = async (language: Language) => {
  const { t } = createI18n(language);
  await Notifications.deleteNotificationChannelAsync(RETIRED_CHANNEL);
  for (const kind of NotificationKind.literals) {
    await Notifications.setNotificationChannelAsync(kind, {
      name: t(CHANNEL_NAMES[kind]),
      importance: Notifications.AndroidImportance.HIGH,
    });
  }
};

/** The language the channels were last named in. */
let channelsNamedIn: Language | null = null;

/**
 * Names the channels in the language the app shows, unless they already are.
 * A build that cannot receive pushes makes none: the system's settings would
 * list kinds of notification the app never shows.
 */
const nameChannels = (): void => {
  const language = shownLanguage();
  if (Platform.OS !== "android" || pushProject() === null || language === channelsNamedIn) return;
  channelsNamedIn = language;
  createChannels(language).catch((error: unknown) => {
    channelsNamedIn = null;
    logUnshown("The notification channels could not be created.", error);
  });
};

/** Whether the app has a socket open now, which tells it what a push would. */
const connected = (session: Session): boolean => {
  const state = session.state.get();
  return state._tag === "open" && state.client.connection.get()._tag === "connected";
};

/**
 * What the app does about notifications before anything else: the channels
 * a push shows in, and how one shows while the app is in the foreground. The
 * server pushes only to a device with no socket open, so one that arrives
 * while the app is open but not connected shows as it would in the
 * background. One that arrives once it is connected raced the socket's
 * opening, and the roster already shows its entry unread: it shows nothing.
 */
export const setUpNotifications = (session: Session): void => {
  Notifications.setNotificationHandler({
    handleNotification: () => {
      const shown = !connected(session);
      return Promise.resolve({
        shouldShowBanner: shown,
        shouldShowList: shown,
        shouldPlaySound: shown,
        shouldSetBadge: false,
      });
    },
  });
  nameChannels();
};

/**
 * The id Expo keeps this phone's push token under for `pairing`: a UUID
 * (version 8, its own kind) shaped from a hash of the pairing's id, so each
 * pairing has a token of its own, the same each time, with nothing stored.
 * When the device's token changes, Expo moves by itself only the token kept
 * under the app's installation id, which no server holds: never one a
 * pairing registered.
 */
const pushDeviceId = async (pairing: DeviceId): Promise<string> => {
  const hex = await Crypto.digestStringAsync(
    Crypto.CryptoDigestAlgorithm.SHA256,
    `j3-bots push ${pairing}`,
  );
  const variant = ((Number.parseInt(hex.charAt(16), 16) & 0x3) | 0x8).toString(16);
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `8${hex.slice(13, 16)}`,
    `${variant}${hex.slice(17, 20)}`,
    hex.slice(20, 32),
  ].join("-");
};

/** The phone's Expo push token for a pairing, fetched once, and again after a failure or a change. */
let token: { readonly pairing: DeviceId; readonly fetched: Promise<PushToken> } | null = null;
const decodeToken = Schema.decodeUnknownOption(PushToken);

const pushToken = (project: string, pairing: DeviceId): Promise<PushToken> => {
  if (token?.pairing === pairing) return token.fetched;
  const fetched = pushDeviceId(pairing)
    .then((deviceId) => Notifications.getExpoPushTokenAsync({ projectId: project, deviceId }))
    .then(({ data }) =>
      // The error names no token: a log is no place for one.
      Option.getOrThrowWith(
        decodeToken(data),
        () => new Error("The push service gave a token the server would refuse."),
      ),
    );
  const cached = { pairing, fetched };
  token = cached;
  fetched.catch(() => {
    if (token === cached) token = null;
  });
  return fetched;
};

/** What this run of the app last told the server of a pairing's pushes. */
interface Told {
  readonly pairing: DeviceId;
  /** The token and language registered, or `null` after it ended the registration. */
  readonly registered: { readonly token: PushToken; readonly language: Language } | null;
}
let told: Told | null = null;

/**
 * One change to this phone's pushes at a time, in the order they were asked
 * for. A change that fails is logged; the next is made regardless.
 */
let queue: Promise<void> = Promise.resolve();
const serially = (work: () => Promise<void>, failed: string): Promise<void> => {
  queue = queue.then(work).catch((error: unknown) => logUnshown(failed, error));
  return queue;
};

/**
 * Tells the server what it should know of this phone's pushes: its token and
 * language while notifications are allowed, and no registration once the
 * operator refused them. What this run of the app already told it is not
 * sent again, unless `again`. Never asks for the permission. Waits for a
 * socket, so in the background it goes once the app returns.
 */
const reconcile = (client: J3Client, again = false): Promise<void> =>
  serially(async () => {
    if (again) told = null;
    const pairing = client.pairing.get();
    const project = pushProject();
    if (pairing === null || project === null || pushPlatform === null) return;
    const access = accessOf(await Notifications.getPermissionsAsync());
    if (access === "granted") {
      const registered = { token: await pushToken(project, pairing), language: shownLanguage() };
      const known = told?.pairing === pairing ? told.registered : undefined;
      if (known?.token === registered.token && known.language === registered.language) return;
      const commandId = await client.commandId();
      const exit = await client.call((rpc) =>
        rpc["push.register"]({
          commandId,
          provider: "expo",
          platform: pushPlatform,
          ...registered,
        }),
      );
      // A pairing that ended, or one the server revoked, is nobody's to push to.
      if (Exit.isSuccess(exit)) told = { pairing, registered };
    } else if (access === "denied" || access === "blocked") {
      if (told?.pairing === pairing && told.registered === null) return;
      const commandId = await client.commandId();
      const exit = await client.call((rpc) => rpc["push.unregister"]({ commandId }));
      if (Exit.isSuccess(exit)) told = { pairing, registered: null };
    }
  }, "This phone's push registration could not be brought up to date.");

/** Clears the notifications this phone shows. Never fails: what fails is logged. */
const dismissShown = (): void => {
  Notifications.dismissAllNotificationsAsync().catch((error: unknown) =>
    logUnshown("The notifications shown could not be cleared.", error),
  );
};

/**
 * Keeps the server's registration of this phone current for as long as the
 * app runs: for each pairing as it starts; when the app returns to the
 * foreground, all of it sent again, since the operator may have allowed or
 * refused notifications in the system's settings meanwhile, or changed the
 * phone's language, and the server may have dropped the registration; when
 * the operator chooses another language in Settings; and when the push
 * service gives the app a new token. A pairing that ends, as when another
 * device revokes this one, takes the notifications it showed. The channels
 * follow the language the app shows.
 */
export const keepPushRegistered = (session: Session): void => {
  const current = (): J3Client | null => {
    const state = session.state.get();
    return state._tag === "open" ? state.client : null;
  };
  const refresh = (again = false) => {
    const client = current();
    if (client !== null) void reconcile(client, again);
  };
  const watch = (client: J3Client) => {
    let pairing = client.pairing.get();
    return client.pairing.subscribe(() => {
      const ended = pairing !== null && client.pairing.get() === null;
      pairing = client.pairing.get();
      if (ended) dismissShown();
      refresh();
    });
  };
  let followed: { readonly client: J3Client; readonly stop: () => void } | null = null;
  const follow = () => {
    const client = current();
    if (followed?.client === client) return;
    followed?.stop();
    followed = client === null ? null : { client, stop: watch(client) };
    refresh();
  };
  session.state.subscribe(follow);
  follow();
  // A language chosen in Settings: the server words pushes in it from now on.
  subscribePreferences(() => {
    nameChannels();
    refresh();
  });
  AppState.addEventListener("change", (status) => {
    if (status !== "active") return;
    nameChannels();
    refresh(true);
  });
  Notifications.addPushTokenListener(() => {
    token = null;
    refresh();
  });
};

/**
 * Asks to allow notifications on this phone, then registers it with the
 * server. The only thing that asks for the permission: Settings' "Allow
 * notifications on this phone". Once the operator refused them for good, the
 * system shows no dialog, so it opens the app's page in the system's settings
 * instead; an answer given in the dialog it showed is left as it was.
 */
export const allowNotifications = async (client: J3Client): Promise<NotificationAccess> => {
  const access = await readAccess();
  if (access === "unavailable") return access;
  if (access === "blocked") {
    await Linking.openSettings();
    return access;
  }
  const asked =
    access === "granted" ? access : accessOf(await Notifications.requestPermissionsAsync());
  await reconcile(client);
  return asked;
};

/**
 * Starts ending this phone's pushes for a pairing it left: clears the
 * notifications it shows, and has the push service forget the device's token
 * (on Android, Firebase deletes it), so a server that still lists the
 * pairing, as after a sign-out it never confirmed, reaches the phone no more
 * (`DeviceNotRegistered`). The token the next pairing registers is its own,
 * for the device's next token. Returns at once, for this waits on the push
 * service; a registration asked for later waits for it. Never fails: what
 * fails is logged.
 */
export const endPush = (): void => {
  void serially(async () => {
    told = null;
    token = null;
    if (pushPlatform === null || pushProject() === null) return;
    await Promise.all([
      Notifications.dismissAllNotificationsAsync(),
      Notifications.unregisterForNotificationsAsync(),
    ]);
  }, "This phone's pushes could not be ended here.");
};
