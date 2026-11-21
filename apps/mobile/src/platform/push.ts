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
import * as Notifications from "expo-notifications";
import { AppState, Platform } from "react-native";
import { deviceLanguage } from "../i18n.ts";
import type { Session } from "../session.ts";

// Push notifications through Expo's push service (decision 0014): this
// phone's Expo push token, registered with the server it is paired with, in
// the language the phone shows. The server pushes to a device with no socket
// open, which is this app in the background (`Lifecycle`). What a tap opens is
// `useNotificationTaps`.

/**
 * What the operator decided about notifications on this phone.
 *
 * @public Settings shows it.
 */
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
const warn = (message: string, error: unknown) => {
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
const readAccess = async (): Promise<NotificationAccess> =>
  pushPlatform === null || pushProject() === null
    ? "unavailable"
    : accessOf(await Notifications.getPermissionsAsync());

/** The name of the Android channel each kind of push shows in. */
const CHANNEL_NAMES = {
  message: "notification.channel.message",
  question: "notification.channel.question",
  approval: "notification.channel.approval",
  "secret-request": "notification.channel.secret",
  handoff: "notification.channel.handoff",
} as const satisfies Record<NotificationKind, KeyWith>;

/**
 * Creates the Android channel each kind of push shows in, its id the kind the
 * server names (`NotificationKind`), so the operator can silence one kind
 * alone. One created before keeps what the operator chose for it and takes
 * the name in the phone's language now.
 */
const createChannels = async (language: Language) => {
  if (Platform.OS !== "android") return;
  const { t } = createI18n(language);
  for (const kind of NotificationKind.literals) {
    await Notifications.setNotificationChannelAsync(kind, {
      name: t(CHANNEL_NAMES[kind]),
      importance: Notifications.AndroidImportance.HIGH,
    });
  }
};

/**
 * What the app does about notifications before anything else: the channels
 * a push shows in, and nothing shown while the app is in the foreground. The
 * server pushes only to a device with no socket open, so a push that reaches
 * the app in the foreground raced the socket's opening, and the roster
 * already shows its entry unread.
 */
export const setUpNotifications = (): void => {
  Notifications.setNotificationHandler({
    handleNotification: () =>
      Promise.resolve({
        shouldShowBanner: false,
        shouldShowList: false,
        shouldPlaySound: false,
        shouldSetBadge: false,
      }),
  });
  createChannels(deviceLanguage()).catch((error: unknown) =>
    warn("The notification channels could not be created.", error),
  );
};

/** The phone's Expo push token, fetched once, and again after a failure or a change. */
let token: Promise<PushToken> | null = null;
const decodeToken = Schema.decodeUnknownOption(PushToken);

const pushToken = (project: string): Promise<PushToken> => {
  if (token !== null) return token;
  const fetched = Notifications.getExpoPushTokenAsync({ projectId: project }).then(({ data }) =>
    // The error names no token: a log is no place for one.
    Option.getOrThrowWith(
      decodeToken(data),
      () => new Error("The push service gave a token the server would refuse."),
    ),
  );
  token = fetched;
  fetched.catch(() => {
    if (token === fetched) token = null;
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
  queue = queue.then(work).catch((error: unknown) => warn(failed, error));
  return queue;
};

/**
 * Tells the server what it should know of this phone's pushes: its token and
 * language while notifications are allowed, and no registration once the
 * operator refused them. What this run of the app already told it is not
 * sent again. Never asks for the permission. Waits for a socket, so in the
 * background it goes once the app returns.
 */
const reconcile = (client: J3Client): Promise<void> =>
  serially(async () => {
    const pairing = client.pairing.get();
    const project = pushProject();
    if (pairing === null || project === null || pushPlatform === null) return;
    const access = accessOf(await Notifications.getPermissionsAsync());
    if (access === "granted") {
      const registered = { token: await pushToken(project), language: deviceLanguage() };
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

/**
 * Keeps the server's registration of this phone current for as long as the
 * app runs: for each pairing as it starts, when the app returns to the
 * foreground (the operator may have allowed or refused notifications in the
 * system's settings meanwhile, or changed the phone's language), and when the
 * push service gives the app a new token.
 */
export const keepPushRegistered = (session: Session): void => {
  const current = (): J3Client | null => {
    const state = session.state.get();
    return state._tag === "open" ? state.client : null;
  };
  const refresh = () => {
    const client = current();
    if (client !== null) void reconcile(client);
  };
  let followed: { readonly client: J3Client; readonly stop: () => void } | null = null;
  const follow = () => {
    const client = current();
    if (followed?.client === client) return;
    followed?.stop();
    followed = client === null ? null : { client, stop: client.pairing.subscribe(refresh) };
    refresh();
  };
  session.state.subscribe(follow);
  follow();
  AppState.addEventListener("change", (status) => {
    if (status === "active") refresh();
  });
  Notifications.addPushTokenListener(() => {
    token = null;
    refresh();
  });
};

/**
 * Asks to allow notifications on this phone, then registers it with the
 * server. The only thing that asks for the permission: Settings' "Allow
 * notifications on this phone".
 *
 * @public Settings calls it.
 */
export const allowNotifications = async (client: J3Client): Promise<NotificationAccess> => {
  const access = await readAccess();
  if (access === "unavailable" || access === "blocked") return access;
  const asked =
    access === "granted" ? access : accessOf(await Notifications.requestPermissionsAsync());
  await reconcile(client);
  return asked;
};

/**
 * Ends this phone's pushes for a pairing it left: clears the notifications it
 * shows, and has the push service forget the app's token, so a server that
 * still lists the pairing, as after a sign-out it never confirmed, reaches
 * the phone no more (`DeviceNotRegistered`). A later registration gets a new
 * token. Never fails: what fails is logged.
 */
export const endPush = (): Promise<void> =>
  serially(async () => {
    told = null;
    token = null;
    if (pushPlatform === null || pushProject() === null) return;
    await Promise.all([
      Notifications.dismissAllNotificationsAsync(),
      Notifications.unregisterForNotificationsAsync(),
    ]);
  }, "This phone's pushes could not be ended here.");
