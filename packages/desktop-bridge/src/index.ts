// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  BotId,
  BrowserTabRef,
  ConnectorId,
  DeviceId,
  DeviceToken,
  EntryId,
  EntryTarget,
  Label,
  Language,
  LookingAt,
  PairBotIds,
  PairingCode,
  PairingLinkTarget,
  RoutineId,
  ServerOrigin,
  SIGN_IN_RETURN_MAX,
  UpdateChannel,
} from "@j3-bots/contracts";
import { releaseTag } from "@j3-bots/release";
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

/**
 * Where the bots live: on this computer, in a server the app runs itself
 * (`local`), or on a server the operator named (`remote`).
 */
export const DesktopMode = Schema.Literals(["local", "remote"]);
export type DesktopMode = typeof DesktopMode.Type;

/**
 * Where the server the app runs on this computer stands. `stopped`: it is not
 * running and the app is not starting it. `starting`: it was started and has
 * not answered yet. `ready`: it answers, and devices can be signed in on it.
 * `restarting`: it stopped on its own, and the app starts it again in
 * `retryInSeconds` (attempt `attempt`). `failed`: it refused to start, for a
 * reason trying again will not change; `reason` and `fix` say what, in the
 * server's words, and the app waits for the operator to try again.
 */
export const LocalServerPhase = Schema.Literals([
  "stopped",
  "starting",
  "ready",
  "restarting",
  "failed",
]);
export type LocalServerPhase = typeof LocalServerPhase.Type;

const Message = Schema.String.check(Schema.isMaxLength(4096));
const LogTail = Schema.String.check(Schema.isMaxLength(8192));
/** A J3 Bots release, as its `release.json` names it. */
const ReleaseVersion = Schema.String.check(Schema.isPattern(/^[0-9A-Za-z.+-]{1,64}$/));

/**
 * What the server on this computer's version is going through, beyond its
 * state. `updating`: the app carries a new release, `to`, and moves the
 * bots' data from `from` to it: a copy first, then `to` started on it. While
 * it does, the state is `starting`. `rolled-back`: `failed` did not become
 * ready, so the data as it was before was put back and `running` runs on it;
 * the app does not try `failed` again until the operator asks
 * (`retryServerUpdate`). `reason` and `logTail` say why, when the app saw it
 * fail since it started. `older-app`: this app carries `app`, older than
 * `running`, which the data was last handed to and which reads it, so it
 * runs `running` instead.
 */
export const ServerUpdate = Schema.Union([
  Schema.TaggedStruct("updating", { from: ReleaseVersion, to: ReleaseVersion }),
  Schema.TaggedStruct("rolled-back", {
    running: ReleaseVersion,
    failed: ReleaseVersion,
    reason: Schema.optionalKey(Message),
    logTail: Schema.optionalKey(LogTail),
  }),
  Schema.TaggedStruct("older-app", { running: ReleaseVersion, app: ReleaseVersion }),
]);
export type ServerUpdate = typeof ServerUpdate.Type;

export const LocalServerState = Schema.Struct({
  state: LocalServerPhase,
  /** Which start this is since the server last ran well, from 1. */
  attempt: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
  /** While `restarting`: in how many seconds the next start is. */
  retryInSeconds: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  /** Why it is stopped or failed, in the server's or the app's words (English). */
  reason: Schema.optionalKey(Message),
  /** What repairs it, when that is known apart from `reason`. */
  fix: Schema.optionalKey(Message),
  /** The last lines the server wrote to its log, for the page to show on request. */
  logTail: Schema.optionalKey(LogTail),
  /** What its version is going through, if anything: see `ServerUpdate`. */
  update: Schema.optionalKey(ServerUpdate),
});
export type LocalServerState = typeof LocalServerState.Type;

/**
 * Why phones cannot reach the server on this computer while the operator
 * wants them to: this network gives the computer a public address
 * (`public-address`), which the server will not listen on without HTTPS, so
 * it stays on this computer alone; the server did not start on the network,
 * and runs on this computer alone until the operator tries again
 * (`unavailable`); it listens on the network, but this computer is on none
 * with a private address (`no-network`); or the server failed, and runs
 * nowhere until the operator tries it again (`not-running`), as
 * `LocalServerState` says.
 */
export const PhoneAccessRefusal = Schema.Literals([
  "public-address",
  "unavailable",
  "no-network",
  "not-running",
]);
export type PhoneAccessRefusal = typeof PhoneAccessRefusal.Type;

/**
 * Whether phones on this network can reach the server on this computer: the
 * operator's choice (`on`), kept between launches; the origins a phone can
 * open while it holds (best first, private addresses only, none while off or
 * while the server is being moved); and why it does not hold, if it does
 * not, with what the server said (`detail`) when it did not start on the
 * network.
 */
export const PhoneAccess = Schema.Struct({
  on: Schema.Boolean,
  origins: Schema.Array(ServerOrigin).check(Schema.isMaxLength(16)),
  refusedReason: Schema.optionalKey(PhoneAccessRefusal),
  detail: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(4096))),
});
export type PhoneAccess = typeof PhoneAccess.Type;

/** How many names of the files an export left out the app keeps to show. */
export const LEFT_OUT_NAMES_SHOWN = 20;

const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

/** What the export of the bots on this computer left out, from its report. */
export const LeftOut = Schema.Struct({
  /**
   * Why the secrets stayed behind, when they did: under a key that is missing
   * or another one, or changed by a newer release.
   */
  secrets: Schema.optionalKey(Schema.Literals(["unreadable", "newer"])),
  /** Links in the bots' folders, which an export never carries. */
  links: Count,
  /** Files whose name no import takes: how many, and the first of them by path. */
  names: Count,
  firstNames: Schema.Array(Schema.String.check(Schema.isMaxLength(4096))).check(
    Schema.isMaxLength(LEFT_OUT_NAMES_SHOWN),
  ),
  /** Attachments already missing on this computer. */
  attachmentsMissing: Count,
});
export type LeftOut = typeof LeftOut.Type;

/**
 * The export the bots on this computer were moved with: its file, when it
 * was written, and what it left out.
 */
export const MovedAway = Schema.Struct({
  file: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096)),
  at: Schema.DateTimeUtcFromString,
  leftOut: LeftOut,
});
export type MovedAway = typeof MovedAway.Type;

/** What the desktop app holds that the page needs before it starts. */
export const DesktopState = Schema.Struct({
  /**
   * The server the page runs on: the one the operator named, or, in `local`
   * mode, the server on this computer (`http://127.0.0.1:<port>`, a port the
   * app chose once). `null` until there is one.
   */
  server: Schema.NullOr(ServerOrigin),
  /**
   * The code of the pairing link the operator followed to `server`, for the
   * pairing screen to start with: given once, to the page that loads right
   * after the server address screen kept that server (`ConnectRequest`).
   */
  pairingCode: Schema.NullOr(PairingCode),
  /** Where the bots live, or `null` until the operator has chosen. */
  mode: Schema.NullOr(DesktopMode),
  /**
   * Whether this computer can run the server: false on systems the app does
   * not run it on, where only a server elsewhere can be named.
   */
  localAvailable: Schema.Boolean,
  /** The server on this computer, in `local` mode; `null` in any other. */
  localServer: Schema.NullOr(LocalServerState),
  phoneAccess: PhoneAccess,
  /** Whether the app starts, in the tray, when the operator signs in to the system. */
  startWithSystem: Schema.Boolean,
  /**
   * The bots on this computer were moved to another server (`LocalExportResult`):
   * where the export was written and when. Their data is still here, and the
   * server on this computer does not start until the operator runs them here
   * again. Absent while they were not.
   */
  moved: Schema.optionalKey(MovedAway),
});
export type DesktopState = typeof DesktopState.Type;

/**
 * How choosing where the bots live ended: `changed`, and the page loads again
 * in the new mode, or `failed`, and nothing changed. `unavailable`: this
 * computer cannot run the server (`DesktopState.localAvailable`).
 */
export const ModeChange = Schema.Literals(["changed", "failed", "unavailable"]);
export type ModeChange = typeof ModeChange.Type;

/**
 * How choosing this computer ended: as `ModeChange` says, or `home-refused`,
 * and nothing changed: the folder where the bots would keep their data is
 * not one only this user can open, or the app could not tell. `reason` says
 * why and `fix` what repairs it (English); choosing this computer again
 * checks the folder again.
 */
export const UseThisComputerResult = Schema.Union([
  ModeChange,
  Schema.TaggedStruct("home-refused", { reason: Message, fix: Message }),
]);
export type UseThisComputerResult = typeof UseThisComputerResult.Type;

/** The shortest passphrase an export takes (`j3-bots export`). */
export const EXPORT_PASSPHRASE_MIN_LENGTH = 8;

/**
 * What the page asks for to move the bots on this computer to another
 * server: the passphrase the export seals their secrets under, which the
 * operator typed twice. The app asks where to write the file.
 */
export const LocalExportRequest = Schema.Struct({
  passphrase: Schema.String.check(
    Schema.isMinLength(EXPORT_PASSPHRASE_MIN_LENGTH),
    Schema.isMaxLength(1024),
  ),
});
export type LocalExportRequest = typeof LocalExportRequest.Type;

/**
 * How moving the bots on this computer ended:
 *
 * - `exported`: the export is written, the server on this computer stopped,
 *   and the page loads again on the screen that says they moved;
 * - `cancelled`: the operator closed the save dialog, and nothing changed;
 * - `refused`: the file chosen cannot take the export, and nothing changed,
 *   the bots still running: a file is already there (`taken`), or it lies in
 *   the bots' data on this computer (`inside-data`), which deleting it would
 *   delete too;
 * - `failed`: nothing was exported, for `reason` (English, the export's own
 *   words when it gave them), and the bots run here again.
 */
export const LocalExportResult = Schema.Union([
  Schema.TaggedStruct("exported", {}),
  Schema.TaggedStruct("cancelled", {}),
  Schema.TaggedStruct("refused", { reason: Schema.Literals(["taken", "inside-data"]) }),
  Schema.TaggedStruct("failed", { reason: Schema.optionalKey(Message) }),
]);
export type LocalExportResult = typeof LocalExportResult.Type;

/**
 * What the page asks for to sign this computer in to the server it runs.
 * `again`: the operator asked to sign in again, after this computer was
 * signed out. Without it, the app signs a device in only the first time after
 * the operator chose this computer: a device that was signed out (revoked
 * from another device, say) stays signed out until the operator asks.
 */
export const LocalDeviceRequest = Schema.Struct({ again: Schema.Boolean });
export type LocalDeviceRequest = typeof LocalDeviceRequest.Type;

export const LocalDeviceResult = Schema.Union([
  /**
   * A new device on the server at `server`, signed in with `token`, which
   * the page seals and keeps as after pairing. It replaces the device this
   * computer was signed in as before, which the server revoked.
   */
  Schema.TaggedStruct("minted", { server: ServerOrigin, deviceId: DeviceId, token: DeviceToken }),
  /** This computer was signed in before: only the operator signs it in again (`again`). */
  Schema.TaggedStruct("signed-out", {}),
  /** The server is not ready (`DesktopState.localServer` says why), or the app is not in `local` mode. */
  Schema.TaggedStruct("not-running", {}),
  /** The server did not sign the device in. */
  Schema.TaggedStruct("failed", {}),
]);
export type LocalDeviceResult = typeof LocalDeviceResult.Type;

/**
 * Turns phone access on or off. Either way the server on this computer
 * starts again, on the network or on this computer alone, which stops the
 * work bots have running: `stopWork` says the operator agreed to that.
 * Asking for `on` while it is on, but not held, tries the network again.
 */
export const PhoneAccessRequest = Schema.Struct({ on: Schema.Boolean, stopWork: Schema.Boolean });
export type PhoneAccessRequest = typeof PhoneAccessRequest.Type;

/**
 * How a `PhoneAccessRequest` ended: `changed`, and the server moves if it
 * must, which `access` follows (`onPhoneAccess`); `work-running`, nothing
 * changed, since `bots` bots have work running that the restart would stop,
 * or, `null`, the server could not say whether any has, and the operator did
 * not agree to it yet; `not-saved`, the choice could not be kept, as when the
 * bots no longer live on this computer, and nothing changed. `access` is what
 * holds after it.
 */
export const PhoneAccessChange = Schema.Union([
  Schema.TaggedStruct("changed", { access: PhoneAccess }),
  Schema.TaggedStruct("work-running", {
    bots: Schema.NullOr(Schema.Int.check(Schema.isGreaterThan(0))),
  }),
  Schema.TaggedStruct("not-saved", { access: PhoneAccess }),
]);
export type PhoneAccessChange = typeof PhoneAccessChange.Type;

/**
 * Asks for a pairing code for a phone. `unlock`: the operator, at this
 * computer, lifts the lock that wrong codes put on pairing first.
 */
export const LocalPairingRequest = Schema.Struct({ unlock: Schema.Boolean });
export type LocalPairingRequest = typeof LocalPairingRequest.Type;

/**
 * A pairing code for a phone to scan, from the server on this computer.
 * `granted`: the code, when it expires, and the private origins a phone
 * reaches the server at, best first, never loopback: the link for the QR code
 * is `<origins[0]>/pair#<code>`, and the others are alternatives.
 * `phone-access-off`: phones cannot reach the server, so no link can work.
 * `locked`: too many wrong codes were tried, until `until`. `unavailable`:
 * the server on this computer is not running. Times cross the bridge as ISO
 * strings: IPC's structured clone keeps no `DateTime`.
 */
export const LocalPairingLink = Schema.Union([
  Schema.TaggedStruct("granted", {
    code: PairingCode,
    expiresAt: Schema.DateTimeUtcFromString,
    origins: Schema.Array(ServerOrigin).check(Schema.isMinLength(1), Schema.isMaxLength(16)),
  }),
  Schema.TaggedStruct("phone-access-off", {}),
  Schema.TaggedStruct("locked", { until: Schema.DateTimeUtcFromString }),
  Schema.TaggedStruct("unavailable", {}),
]);
export type LocalPairingLink = typeof LocalPairingLink.Type;

export const StartWithSystemRequest = Schema.Struct({ on: Schema.Boolean });
export type StartWithSystemRequest = typeof StartWithSystemRequest.Type;

/**
 * How changing whether the app starts with the system ended: `changed`, or
 * `not-saved`, and the system starts the app as it did; `on` is what holds now.
 */
export const StartWithSystemChange = Schema.Struct({
  outcome: Schema.Literals(["changed", "not-saved"]),
  on: Schema.Boolean,
});
export type StartWithSystemChange = typeof StartWithSystemChange.Type;

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
 * `verifying`: it is downloaded, and the app checks it against the release's
 * signed checksums before it offers anything. `downloaded`: it matched, and
 * restarting into it is `offered`, or was asked for and waits until no save is
 * under way (`waiting-for-save`), which the operator may call off; where
 * updates install by themselves, it also installs as the app quits.
 * `installing`: the app is restarting into it, or installing it as it quits.
 * `failed`: the last check or download (`check`) failed, the download did not
 * match the release's signed checksums, or they could not be read (`verify`),
 * or installing `version` failed (`install`), which the operator can still
 * download from its release page; the next check tries again.
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
  Schema.TaggedStruct("verifying", { version: AppVersion }),
  Schema.TaggedStruct("downloaded", {
    version: AppVersion,
    restart: Schema.Literals(["offered", "waiting-for-save"]),
  }),
  Schema.TaggedStruct("installing", { version: AppVersion }),
  Schema.TaggedStruct("failed", { stage: Schema.Literals(["check", "verify"]) }),
  Schema.TaggedStruct("failed", { stage: Schema.Literal("install"), version: AppVersion }),
]);
export type UpdatePhase = typeof UpdatePhase.Type;

/**
 * The page of the release that carries `version`, where a build that does
 * not install updates sends the operator: in the repository whose releases
 * are the update feed (`publish` in `apps/desktop/electron-builder.yml`).
 */
export const releasePage = (version: AppVersion): string =>
  `https://github.com/JPSAUD501/j3-bots/releases/tag/${releaseTag(version)}`;

/** The folder the files of the release that carries `version` download from, ending in `/`. */
export const releaseFolder = (version: AppVersion): string =>
  `https://github.com/JPSAUD501/j3-bots/releases/download/${releaseTag(version)}/`;

/** A file `name` of the release that carries `version`, in the same repository. */
export const releaseFile = (version: AppVersion, name: string): string =>
  `${releaseFolder(version)}${encodeURIComponent(name)}`;

/**
 * Where the update the app makes as it starts stands, in a build that
 * installs updates by itself. `checking`: the check at launch is under way,
 * for at most a few seconds. `updating`: it found a newer version, which the
 * app downloads, checks and restarts into, and the page shows only that.
 * `over`: the app opened as usual, nothing newer found in time, the check
 * failed, or the update did; anything found from now on installs as the app
 * quits.
 */
export const LaunchUpdate = Schema.Literals(["checking", "updating", "over"]);
export type LaunchUpdate = typeof LaunchUpdate.Type;

/**
 * The app's own version, the releases it follows (`channel`), where updating
 * it stands, whether a verified version installs by itself (`automatic`, the
 * operator's "Update automatically"; `null` in a build that does not install
 * updates), and the update it makes as it starts (`launch`).
 */
export const UpdateStatus = Schema.Struct({
  current: AppVersion,
  channel: UpdateChannel,
  phase: UpdatePhase,
  automatic: Schema.NullOr(Schema.Boolean),
  launch: LaunchUpdate,
});
export type UpdateStatus = typeof UpdateStatus.Type;

/** The releases the operator chose for the app to follow. */
export const UpdateChannelRequest = Schema.Struct({ channel: UpdateChannel });
export type UpdateChannelRequest = typeof UpdateChannelRequest.Type;

/** Whether the operator wants a verified version to install by itself ("Update automatically"). */
export const AutomaticUpdatesRequest = Schema.Struct({ on: Schema.Boolean });
export type AutomaticUpdatesRequest = typeof AutomaticUpdatesRequest.Type;

/** Whether a save is under way in the page, as it reports each change. */
export const SavingReport = Schema.Struct({ saving: Schema.Boolean });
export type SavingReport = typeof SavingReport.Type;

/** The side, in px, of the icon a notification shows: the page draws avatars at this size. */
export const NOTIFICATION_ICON_SIZE = 192;

/**
 * The first 24 bytes every PNG file begins with: its signature, then the
 * header chunk (`IHDR`, whose data is 13 bytes), whose first eight bytes of
 * data are the image's width and height.
 */
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const IHDR = [0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52];
const PNG_HEAD = [...PNG_SIGNATURE, ...IHDR];

/** Whether `bytes` begin as a PNG of at most `side` px each way, as its header says. */
const pngWithin = (bytes: Uint8Array, side: number): boolean => {
  if (bytes.length < PNG_HEAD.length + 8) return false;
  if (!PNG_HEAD.every((byte, index) => bytes[index] === byte)) return false;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = view.getUint32(PNG_HEAD.length);
  const height = view.getUint32(PNG_HEAD.length + 4);
  return width >= 1 && width <= side && height >= 1 && height <= side;
};

/**
 * A notification's icon, as the main process takes it: a PNG file of at
 * most `NOTIFICATION_ICON_SIZE` px each way, as its header says, and under
 * 1 MiB (a 192 px avatar is a few tens of kilobytes). The main process
 * decodes it outside any sandbox, and a small file could otherwise declare
 * an image that takes gigabytes to decode; a decoder that finds the header
 * lying fails instead.
 */
export const Png = Schema.Uint8Array.check(
  Schema.isMaxLength(1024 * 1024),
  Schema.makeFilter((bytes: Uint8Array) => pngWithin(bytes, NOTIFICATION_ICON_SIZE)),
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

/** The language the page shows, which the app's menus follow. */
export const LanguageReport = Schema.Struct({ language: Language });
export type LanguageReport = typeof LanguageReport.Type;

/** A light or dark theme. */
export const Theme = Schema.Literals(["light", "dark"]);
export type Theme = typeof Theme.Type;

/** The operator's choice of theme: the system's, or one of the two. */
export const Appearance = Schema.Literals(["system", "light", "dark"]);
export type Appearance = typeof Appearance.Type;

/**
 * The appearance the operator chose, as the page reports it when it starts
 * and each time it changes: the app's window, its title bar and its menus
 * follow it, from the first paint of the next launch.
 */
export const AppearanceReport = Schema.Struct({ appearance: Appearance });
export type AppearanceReport = typeof AppearanceReport.Type;

/** A bot or room that needs the operator, as the tray lists it. */
export const Waiting = Schema.Struct({ target: EntryTarget, name: Label });
export type Waiting = typeof Waiting.Type;

/** How many bots and rooms the tray names; it counts the rest. */
export const TRAY_LISTED = 10;

/**
 * What the tray shows, as the page reports it each time it changes: how many
 * bots and rooms need the operator, the first `TRAY_LISTED` of them in roster
 * order, and the pairing whose roster they come from (`null`, with none,
 * while the page follows none).
 */
export const TrayReport = Schema.Struct({
  pairing: Schema.NullOr(DeviceId),
  count: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  waiting: Schema.Array(Waiting).check(Schema.isMaxLength(TRAY_LISTED)),
});
export type TrayReport = typeof TrayReport.Type;

/**
 * A place in the main window: a bot's conversation or a room, as the tray
 * opens one, or what a conversation leads to and quick access hands over: a
 * bot's browser on a tab (`front`: the one it uses), a teammate conversation
 * at one of its messages, a routine's runs, a connector's sign-in.
 */
export const Destination = Schema.Union([
  EntryTarget,
  Schema.TaggedStruct("browser", {
    botId: BotId,
    // "front" first: a ref is any non-empty string, which would take "front" too.
    tab: Schema.Union([Schema.Literal("front"), BrowserTabRef]),
  }),
  Schema.TaggedStruct("pair", { botIds: PairBotIds, at: Schema.NullOr(EntryId) }),
  Schema.TaggedStruct("routine", { botId: BotId, routineId: RoutineId }),
  Schema.TaggedStruct("connector", { connectorId: ConnectorId }),
]);
export type Destination = typeof Destination.Type;

/**
 * Something the app asks the page to do, from its menus, its tray or quick
 * access. `focus`: the composer of the open conversation, or the roster.
 * `composer`, `next`, `previous`, `stop` and `closeDetails`: the shell's
 * keyboard shortcuts, by name. `open`: a place the operator chose in the
 * tray or in quick access, under the pairing whose roster listed it.
 */
export const ShellCommand = Schema.Union([
  Schema.TaggedStruct("focus", {}),
  Schema.TaggedStruct("composer", {}),
  Schema.TaggedStruct("next", {}),
  Schema.TaggedStruct("previous", {}),
  Schema.TaggedStruct("stop", {}),
  Schema.TaggedStruct("closeDetails", {}),
  Schema.TaggedStruct("open", { target: Destination, pairing: DeviceId }),
]);
export type ShellCommand = typeof ShellCommand.Type;

/** The path of the app's page the quick access window shows. */
export const QUICK_ACCESS_PATH = "/quick";

/**
 * What the quick access window's page tells the app: whether it has what it
 * shows, a primary bot on a server it reached. Until it has, the global
 * shortcut shows the main window instead.
 */
export const QuickAccessReport = Schema.Struct({ available: Schema.Boolean });
export type QuickAccessReport = typeof QuickAccessReport.Type;

/** Which showing of the quick access window something belongs to: each one counts one more. */
const Opening = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

/**
 * Whether the app may take a picture of a window, here and now.
 * `available`: it may. `needs-permission`: macOS lets it only once the
 * operator allows Screen Recording. `none`: this desktop does not let it,
 * or the window cannot be pictured.
 */
export const PictureReach = Schema.Literals(["available", "needs-permission", "none"]);
export type PictureReach = typeof PictureReach.Type;

/**
 * The window that was in front when the global shortcut opened quick
 * access, as the app could read it: the app's name and, unless the
 * operator turned titles off, the window's title (`lookingAt`); whether a
 * picture of it can be taken; and whether the operator asked for one on
 * every message (`pictureByDefault`).
 */
export const SeenWindow = Schema.Struct({
  lookingAt: LookingAt,
  picture: PictureReach,
  pictureByDefault: Schema.Boolean,
});
export type SeenWindow = typeof SeenWindow.Type;

/** The page asks for a picture of the window that was in front as showing `opening` opened. */
export const QuickAccessPictureRequest = Schema.Struct({ opening: Opening });
export type QuickAccessPictureRequest = typeof QuickAccessPictureRequest.Type;

/** The largest side, in pixels, of a picture of a window: a model reads it whole, and it stays small. */
export const MAX_PICTURE_SIDE = 1600;

const PictureSide = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: MAX_PICTURE_SIDE }));

/**
 * A picture of the window, as the app took it: a JPEG of at most
 * `MAX_PICTURE_SIDE` on its longest side, `taken` only when the page asked.
 * `needs-permission`: macOS refused it until the operator allows Screen
 * Recording. `failed`: there was no picture to take, as of a window that
 * closed, or of another showing than the latest.
 */
export const QuickAccessPicture = Schema.Union([
  Schema.TaggedStruct("taken", {
    bytes: Schema.Uint8Array,
    mediaType: Schema.Literal("image/jpeg"),
    width: PictureSide,
    height: PictureSide,
  }),
  Schema.TaggedStruct("needs-permission", {}),
  Schema.TaggedStruct("failed", {}),
]);
export type QuickAccessPicture = typeof QuickAccessPicture.Type;

/**
 * Whether the system lets the app read other apps' windows. `not-needed`:
 * it asks for no permission (Windows, Linux). `granted` or `needed`: macOS's
 * Screen Recording, which reading a window's title or taking its picture
 * needs, was allowed or not yet.
 */
export const ScreenAccess = Schema.Literals(["not-needed", "granted", "needed"]);
export type ScreenAccess = typeof ScreenAccess.Type;

/**
 * What quick access reads of the window in front, on this computer.
 * `reach`: `window`, its app, title and picture; `none`, nothing, on a
 * desktop that lets no app read another's window (Wayland). `title`: the
 * window's title goes with its app, on until the operator turns it off.
 * `pictureByDefault`: a picture of it goes with every message, off until
 * the operator turns it on.
 */
export const LookingAtSettings = Schema.Struct({
  reach: Schema.Literals(["window", "none"]),
  title: Schema.Boolean,
  pictureByDefault: Schema.Boolean,
  screen: ScreenAccess,
});
export type LookingAtSettings = typeof LookingAtSettings.Type;

export const LookingAtChange = Schema.Struct({
  title: Schema.optionalKey(Schema.Boolean),
  pictureByDefault: Schema.optionalKey(Schema.Boolean),
});
export type LookingAtChange = typeof LookingAtChange.Type;

/**
 * What the app tells the quick access window's page. `open`: the window was
 * just shown, or brought back to hand, so the page comes in and puts the
 * cursor in its composer; `opening` numbers that showing. `leave`: the page
 * goes out, then asks for the window to be hidden. `seen`: the window that
 * was in front as showing `opening` opened, once the app has read it; never
 * when it read nothing.
 */
export const QuickAccessCue = Schema.Union([
  Schema.TaggedStruct("open", { opening: Opening }),
  Schema.TaggedStruct("leave", {}),
  Schema.TaggedStruct("seen", { opening: Opening, window: SeenWindow }),
]);
export type QuickAccessCue = typeof QuickAccessCue.Type;

/**
 * The page asks for the window to be hidden, having gone out of the showing
 * `opening` numbers. One the app has shown again since is left up: the ask
 * is older than what the operator last asked for.
 */
export const QuickAccessHide = Schema.Struct({ opening: Opening });
export type QuickAccessHide = typeof QuickAccessHide.Type;

/**
 * The place quick access asks the main window to open, under the pairing
 * whose roster listed it, as a bot chosen in the tray is.
 */
export const QuickAccessOpen = Schema.Struct({ target: Destination, pairing: DeviceId });
export type QuickAccessOpen = typeof QuickAccessOpen.Type;

/** The modifiers that set a global shortcut apart from the ones every app uses. */
const SET_APART: ReadonlySet<string> = new Set(["Alt", "Super", "Shift"]);

/**
 * A global shortcut, as Electron's accelerators write it: one or more of
 * `CommandOrControl`, `Control`, `Alt`, `Super` (in that order, at least one
 * of them), then `Shift` or not, then a letter, a digit, a function key or
 * `Space`. It holds `Alt`, `Super` or `Shift` beside another modifier: a
 * global shortcut takes its keys from every other app, and the ones a single
 * modifier makes are theirs (copy, paste, undo, select all, `Alt+F4`).
 */
export const Accelerator = Schema.String.check(
  Schema.isMaxLength(64),
  Schema.isPattern(
    /^(?=(?:CommandOrControl|Control|Alt|Super)\+)(?:CommandOrControl\+)?(?:Control\+)?(?:Alt\+)?(?:Super\+)?(?:Shift\+)?(?:[A-Z0-9]|F[1-9]|F1[0-9]|F2[0-4]|Space)$/,
  ),
  Schema.makeFilter((accelerator: string) => {
    const modifiers = accelerator.split("+").slice(0, -1);
    return modifiers.length >= 2 && modifiers.some((modifier) => SET_APART.has(modifier));
  }),
);
export type Accelerator = typeof Accelerator.Type;

/** The shortcut that opens quick access until the operator chooses another. */
export const DEFAULT_SHORTCUT: Accelerator = "CommandOrControl+Shift+J";

/**
 * Whether the global shortcut works. `registered`: it does. `taken`: another
 * app or the system holds it. `unavailable`: this desktop lets no app hold a
 * key outside its windows. `requested`: on Wayland, where the desktop decides
 * through its portal and does not tell the app what it decided.
 */
export const ShortcutState = Schema.Literals(["registered", "taken", "unavailable", "requested"]);
export type ShortcutState = typeof ShortcutState.Type;

export const ShortcutStatus = Schema.Struct({ accelerator: Accelerator, state: ShortcutState });
export type ShortcutStatus = typeof ShortcutStatus.Type;

export const ShortcutRequest = Schema.Struct({ accelerator: Accelerator });
export type ShortcutRequest = typeof ShortcutRequest.Type;

/**
 * How changing the shortcut ended: `changed`, and `status` is the new one's;
 * `taken`, another app or the system holds it, and the shortcut that was
 * there stays (`status`); or `not-saved`, the app could not keep it, and the
 * one that was there stays.
 */
export const ShortcutChange = Schema.Struct({
  outcome: Schema.Literals(["changed", "taken", "not-saved"]),
  status: ShortcutStatus,
});
export type ShortcutChange = typeof ShortcutChange.Type;

/**
 * A connector's sign-in, as the page asks the app to catch the browser's
 * return from it, in the language the page that waits for it shows.
 */
export const SignInRelayRequest = Schema.Struct({ language: Language });
export type SignInRelayRequest = typeof SignInRelayRequest.Type;

/** An `http://127.0.0.1:<port>/…` address on this computer's loopback, as the app listens on one. */
export const LoopbackAddress = Schema.String.check(
  Schema.isMaxLength(SIGN_IN_RETURN_MAX),
  Schema.isPattern(/^http:\/\/127\.0\.0\.1:\d{1,5}\/[^\s]*$/),
);

/** A port the app listens on for a sign-in's return; the system picks it, above the reserved ones. */
const LoopbackPort = Schema.Int.check(Schema.isBetween({ minimum: 1024, maximum: 65_535 }));

/**
 * How catching a sign-in started: `listening` on `port`, where the browser is
 * to come back to `http://127.0.0.1:<port>/oauth/callback/<issuer>`, for one sign-in,
 * until it does or ten minutes pass; or `failed`, when no listener could open.
 */
export const SignInRelayStart = Schema.Union([
  Schema.TaggedStruct("listening", { port: LoopbackPort }),
  Schema.TaggedStruct("failed", {}),
]);
export type SignInRelayStart = typeof SignInRelayStart.Type;

/**
 * The `state` the server put in the sign-in the listener on `port` waits for,
 * which the page reads from the address it is about to open: the listener
 * takes no return without it. Printable ASCII, as an address's query carries it.
 */
export const SignInExpectation = Schema.Struct({
  port: LoopbackPort,
  state: Schema.String.check(Schema.isPattern(/^[\x21-\x7e]{1,1024}$/)),
});
export type SignInExpectation = typeof SignInExpectation.Type;

/**
 * A value of a secret the operator copies. The app puts it on the clipboard
 * and takes it off after a while, if the clipboard still holds it then:
 * whatever was copied since stays.
 */
export const SecretCopy = Schema.Struct({
  text: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(10_000)),
});
export type SecretCopy = typeof SecretCopy.Type;

/** Stops the listener on `port`, and no later one the page asked for. */
export const SignInRelayStop = Schema.Struct({ port: LoopbackPort });
export type SignInRelayStop = typeof SignInRelayStop.Type;

/**
 * The browser came back from a sign-in to the address the app listened on:
 * that address as the browser asked for it, with the query the provider added.
 * It carries an authorization code, which the page hands only to the server.
 */
export const SignInReturn = Schema.Struct({ url: LoopbackAddress });
export type SignInReturn = typeof SignInReturn.Type;

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
  cancelRestartToUpdate: Callable,
  setUpdateChannel: Callable,
  setAutomaticUpdates: Callable,
  reportSaving: Callable,
  notify: Callable,
  closeNotifications: Callable,
  onNotificationClick: Callable,
  onAppLink: Callable,
  reportLanguage: Callable,
  reportAppearance: Callable,
  systemTheme: Callable,
  reportTray: Callable,
  onCommand: Callable,
  reportQuickAccess: Callable,
  onQuickAccessCue: Callable,
  hideQuickAccess: Callable,
  openFromQuickAccess: Callable,
  quickAccessPicture: Callable,
  lookingAt: Callable,
  setLookingAt: Callable,
  askScreenAccess: Callable,
  shortcutStatus: Callable,
  setShortcut: Callable,
  useThisComputer: Callable,
  connectToServerInstead: Callable,
  localDevice: Callable,
  onLocalServer: Callable,
  retryLocalServer: Callable,
  retryServerUpdate: Callable,
  setPhoneAccess: Callable,
  onPhoneAccess: Callable,
  localPairingLink: Callable,
  setStartWithSystem: Callable,
  catchSignIn: Callable,
  expectSignIn: Callable,
  stopCatchingSignIn: Callable,
  onSignInReturn: Callable,
  copySecret: Callable,
  exportLocal: Callable,
  runHereAgain: Callable,
  deleteLocalData: Callable,
});
export type HostedBridge = typeof HostedBridge.Type;
