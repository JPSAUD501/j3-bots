// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  DeviceId,
  EntryId,
  EntryTarget,
  PairingCode,
  PairingLinkTarget,
  ServerOrigin,
} from "@j3-bots/contracts";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";

// What the desktop app's preload script and main process exchange with the web
// client they host. This is not wire between the server and its clients, so it
// lives apart from `@j3-bots/contracts`. Every value that crosses the bridge is
// decoded on the side that receives it: the main process decodes what a page
// asks, and the page decodes what the main process answers.

export { BRIDGE_KEY, type DesktopBridge, IPC_CHANNELS } from "./channels.ts";
export { AppLink, AppLinkUrl } from "./link.ts";
// The server, as the desktop app keeps it: the origin the contract defines.
export { ServerOrigin } from "@j3-bots/contracts";

/**
 * How a sealed device token is kept on disk: `encrypted` with a key the
 * system keeps (the macOS Keychain, Windows DPAPI, a Linux secret service),
 * or `unencrypted`, sealed where Linux had no secret service the app could
 * use: then it is only obscured, and anyone who can read the profile can
 * recover it.
 */
export const TokenProtection = Schema.Literals(["encrypted", "unencrypted"]);
export type TokenProtection = typeof TokenProtection.Type;

/** What the desktop app holds that the page needs before it starts. */
export const DesktopState = Schema.Struct({
  /** The server the operator named, or `null` until they have. */
  server: Schema.NullOr(ServerOrigin),
  /**
   * The code of the pairing link the operator followed to `server`, for the
   * pairing screen to start with: given once, to the page that loads right
   * after the server address screen kept that server (`ConnectRequest`).
   */
  pairingCode: Schema.NullOr(PairingCode),
});
export type DesktopState = typeof DesktopState.Type;

/**
 * The address the operator typed on the server address screen, as typed, and
 * the pairing link that filled it in, if one did: once the server the link
 * names is kept, its code goes to the page that loads next (`DesktopState`).
 */
export const ConnectRequest = Schema.Struct({
  address: Schema.String.check(Schema.isMaxLength(2048)),
  pairing: Schema.optionalKey(PairingLinkTarget),
});
export type ConnectRequest = typeof ConnectRequest.Type;

/**
 * Why an address was not kept: it is not an address (`invalid`), it asks for
 * plain HTTP to a host that is not loopback or a private IP address
 * (`needs-https`), nothing answered there (`unreachable`), what answered is
 * not a J3 Bots server (`not-j3-bots`), the app already keeps a server, which
 * must be forgotten first (`server-kept`), or the app could not save it
 * (`not-saved`).
 */
export const ConnectRefusal = Schema.Literals([
  "invalid",
  "needs-https",
  "unreachable",
  "not-j3-bots",
  "server-kept",
  "not-saved",
]);
export type ConnectRefusal = typeof ConnectRefusal.Type;

export const ConnectResult = Schema.Union([
  /** The server answered and is kept; the page loads again to connect to it. */
  Schema.TaggedStruct("connected", { server: ServerOrigin }),
  Schema.TaggedStruct("refused", { reason: ConnectRefusal }),
]);
export type ConnectResult = typeof ConnectResult.Type;

/**
 * How forgetting the server ended: `forgotten`, and the page loads again on
 * the server address screen, or `failed`, and the server is still kept.
 */
export const ForgetResult = Schema.Literals(["forgotten", "failed"]);
export type ForgetResult = typeof ForgetResult.Type;

/** A device token as the page asks the app to seal it, or the app answers it opened. */
const Token = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1024));

/**
 * A sealed token, as the page stores it: base64 in its one canonical form
 * (whole groups of four, padding where it belongs, no stray bits in the
 * last character), never empty. A lenient decoder reads `A` as no bytes at
 * all, and the system opens no bytes as an empty string, so a value is
 * held to the form the app wrote before it is decoded.
 */
export const Sealed = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(4096),
  Schema.isPattern(
    /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/][AQgw]==|[A-Za-z0-9+/]{2}[AEIMQUYcgkosw048]=)?$/,
  ),
);

export const SealRequest = Schema.Struct({ token: Token });
export type SealRequest = typeof SealRequest.Type;

export const SealResult = Schema.Union([
  /** The token, encrypted for this profile, and how. */
  Schema.TaggedStruct("sealed", { sealed: Sealed, protection: TokenProtection }),
  Schema.TaggedStruct("failed", {}),
]);
export type SealResult = typeof SealResult.Type;

export const OpenRequest = Schema.Struct({ sealed: Sealed });
export type OpenRequest = typeof OpenRequest.Type;

export const OpenResult = Schema.Union([
  /** The token. */
  Schema.TaggedStruct("opened", { token: Token }),
  /** It decrypted, but not to a token this profile sealed: the record is damaged or not the app's. */
  Schema.TaggedStruct("failed", {}),
  /**
   * The system did not open it now: its encryption is not available, or it
   * refused, as while a keyring is locked or for a key it no longer has.
   * Trying again later may open it.
   */
  Schema.TaggedStruct("unavailable", {}),
]);
export type OpenResult = typeof OpenResult.Type;

/** Whether the system has a network (Electron's `net.isOnline`). */
export const NetworkState = Schema.Struct({ online: Schema.Boolean });
export type NetworkState = typeof NetworkState.Type;

/** A version of the app, as electron-builder stamps it: semver. */
export const AppVersion = Schema.String.check(
  Schema.isMaxLength(64),
  Schema.isPattern(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/),
);
export type AppVersion = typeof AppVersion.Type;

/**
 * Where updating the app stands. `unavailable`: this build does not check for
 * updates, as a development build with no feed of its own. `idle`: no check is
 * under way; `checked` once one found nothing newer. `released`: a newer
 * version is out, and this build, which does not install updates itself (a
 * deb, an unsigned Mac build), says where to get it. `available` and
 * `downloading`: a newer version is on its way, in the background.
 * `downloaded`: it is ready, and restarting into it is `offered`, or was asked
 * for and waits until no save is under way (`waiting-for-save`).
 * `installing`: the app is restarting into it. `failed`: the last check or
 * download (`check`) or install (`install`) failed; the next check tries again.
 */
export const UpdatePhase = Schema.Union([
  Schema.TaggedStruct("unavailable", {}),
  Schema.TaggedStruct("idle", { checked: Schema.Boolean }),
  Schema.TaggedStruct("checking", {}),
  Schema.TaggedStruct("released", { version: AppVersion }),
  Schema.TaggedStruct("available", { version: AppVersion }),
  Schema.TaggedStruct("downloading", {
    version: AppVersion,
    percent: Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 100 })),
  }),
  Schema.TaggedStruct("downloaded", {
    version: AppVersion,
    restart: Schema.Literals(["offered", "waiting-for-save"]),
  }),
  Schema.TaggedStruct("installing", { version: AppVersion }),
  Schema.TaggedStruct("failed", { stage: Schema.Literals(["check", "install"]) }),
]);
export type UpdatePhase = typeof UpdatePhase.Type;

/**
 * The page of the release that carries `version`, where a build that does
 * not install updates sends the operator: in the repository whose releases
 * are the update feed (`publish` in `apps/desktop/electron-builder.yml`).
 */
export const releasePage = (version: AppVersion): string =>
  `https://github.com/JPSAUD501/j3-bots/releases/tag/v${version}`;

/** The app's own version, and where updating it stands. */
export const UpdateStatus = Schema.Struct({ current: AppVersion, phase: UpdatePhase });
export type UpdateStatus = typeof UpdateStatus.Type;

/** Whether a save is under way in the page, as it reports each change. */
export const SavingReport = Schema.Struct({ saving: Schema.Boolean });
export type SavingReport = typeof SavingReport.Type;

/** The eight bytes every PNG file begins with. */
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/**
 * An image the app shows: a PNG file, no larger than a notification's icon
 * needs (a 192 px avatar is a few tens of kilobytes).
 */
export const Png = Schema.Uint8Array.check(
  Schema.isMaxLength(1024 * 1024),
  Schema.makeFilter((bytes: Uint8Array) =>
    PNG_SIGNATURE.every((byte, index) => bytes[index] === byte),
  ),
);

/**
 * A notification the page shows, as it asks the app to put it on the
 * system's screen: its text and icon, the conversation or room it is about,
 * and the pairing that received it.
 */
export const NotificationRequest = Schema.Struct({
  /** The entry it is about: the app shows one notification per entry. */
  entryId: EntryId,
  title: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1024)),
  body: Schema.String.check(Schema.isMaxLength(4096)),
  /** The still avatar of what it is about, or `null` for the app's icon. */
  icon: Schema.NullOr(Png),
  target: EntryTarget,
  pairing: DeviceId,
});
export type NotificationRequest = typeof NotificationRequest.Type;

/** A pairing that ended, whose notifications the page asks the app to close. */
export const CloseNotificationsRequest = Schema.Struct({ pairing: DeviceId });
export type CloseNotificationsRequest = typeof CloseNotificationsRequest.Type;

/** A click on a notification: what it was about, and the pairing that received it. */
export const NotificationClick = Schema.Struct({ target: EntryTarget, pairing: DeviceId });
export type NotificationClick = typeof NotificationClick.Type;

/** A function, called only to have its answer decoded. */
const Callable = Schema.declare(
  (input: unknown): input is (...args: ReadonlyArray<unknown>) => unknown =>
    Predicate.isFunction(input),
);

/**
 * `window[BRIDGE_KEY]` as the page decodes it: a page in a browser finds
 * nothing there, and the desktop app's page finds its state and its calls.
 */
export const HostedBridge = Schema.Struct({
  state: DesktopState,
  connect: Callable,
  forgetServer: Callable,
  sealToken: Callable,
  openToken: Callable,
  networkStatus: Callable,
  onResumed: Callable,
  relaunch: Callable,
  updateStatus: Callable,
  onUpdate: Callable,
  checkForUpdates: Callable,
  restartToUpdate: Callable,
  reportSaving: Callable,
  notify: Callable,
  closeNotifications: Callable,
  onNotificationClick: Callable,
  onAppLink: Callable,
});
export type HostedBridge = typeof HostedBridge.Type;
