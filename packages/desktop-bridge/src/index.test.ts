// SPDX-License-Identifier: AGPL-3.0-or-later
import { assert, describe, it } from "@effect/vitest";
import { BotId, PairingCode, RoomId } from "@j3-bots/contracts";
import * as DateTime from "effect/DateTime";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import {
  Accelerator,
  AppLinkUrl,
  ConnectRequest,
  ConnectResult,
  DesktopState,
  HostedBridge,
  LocalPairingLink,
  NotificationClick,
  NotificationRequest,
  LocalServerState,
  OpenRequest,
  QuickAccessCue,
  QuickAccessHide,
  QuickAccessOpen,
  QuickAccessReport,
  releaseFile,
  releasePage,
  SavingReport,
  ServerOrigin,
  ShellCommand,
  SignInRelayStart,
  SignInReturn,
  TrayReport,
  UpdateStatus,
} from "./index.ts";

/** The first bytes of a PNG whose header declares `width` by `height` px. */
const pngOf = (width: number, height: number): Uint8Array => {
  const bytes = new Uint8Array(33);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
};

const decodes = <S extends Schema.Constraint & { readonly DecodingServices: never }>(
  schema: S,
  input: unknown,
) => Exit.isSuccess(Schema.decodeUnknownExit(schema)(input));

/** The state of an app that does not run the server on this computer. */
const LOCAL_OFF = {
  mode: "remote",
  localAvailable: false,
  localServer: null,
  phoneAccess: { on: false, origins: [] },
  startWithSystem: false,
} as const;

describe("the desktop bridge", () => {
  it("keeps only a bare http: or https: origin as the server", () => {
    for (const server of [
      "http://192.0.2.10:3737",
      "https://j3.example.test",
      "http://[::1]:3737",
    ]) {
      assert.isTrue(decodes(DesktopState, { ...LOCAL_OFF, server, pairingCode: null }), server);
    }
    for (const server of [
      "http://192.0.2.10:3737/",
      "http://192.0.2.10:3737/api",
      "https://user:secret@j3.example.test",
      "https://j3.example.test?x=1",
      "ws://192.0.2.10:3737",
      "file:///etc/passwd",
      "j3bots://app",
      "192.0.2.10:3737",
      "",
    ]) {
      assert.isFalse(decodes(DesktopState, { ...LOCAL_OFF, server, pairingCode: null }), server);
    }
    assert.isTrue(decodes(DesktopState, { ...LOCAL_OFF, server: null, pairingCode: null }));
    assert.isFalse(decodes(DesktopState, {}));
  });

  it("carries a pairing code for a phone across IPC, as its structured clone copies it", () => {
    const encode = Schema.encodeSync(LocalPairingLink);
    const decode = Schema.decodeUnknownSync(LocalPairingLink);
    const granted: LocalPairingLink = {
      _tag: "granted",
      code: PairingCode.make("7KQ2M9XH4D"),
      expiresAt: DateTime.makeUnsafe("2026-11-23T20:05:00Z"),
      origins: [ServerOrigin.make("http://192.168.1.20:3747")],
    };
    const locked: LocalPairingLink = {
      _tag: "locked",
      until: DateTime.makeUnsafe("2026-11-23T20:20:00Z"),
    };
    for (const link of [granted, locked]) {
      assert.deepStrictEqual(decode(structuredClone(encode(link))), link);
    }
  });

  it("refuses an answer from the main process that is not one it gives", () => {
    assert.isTrue(decodes(ConnectResult, { _tag: "connected", server: "http://192.0.2.10:3737" }));
    assert.isTrue(decodes(ConnectResult, { _tag: "refused", reason: "needs-https" }));
    assert.isFalse(decodes(ConnectResult, { _tag: "connected", server: "http://192.0.2.10/x" }));
    assert.isFalse(decodes(ConnectResult, { _tag: "refused", reason: "because" }));
    assert.isFalse(decodes(ConnectResult, { _tag: "paired" }));
    assert.isFalse(decodes(ConnectResult, "connected"));
  });

  it("carries the local server's update only as the app gives it", () => {
    const ready = { state: "ready", attempt: 1 } as const;
    const rolledBack = { _tag: "rolled-back", running: "0.3.0", failed: "0.3.1" } as const;
    assert.isTrue(decodes(LocalServerState, { ...ready, update: rolledBack }));
    assert.isTrue(
      decodes(LocalServerState, {
        ...ready,
        update: { ...rolledBack, reason: "It stopped with exit code 1.", logTail: "boom" },
      }),
    );
    assert.isTrue(
      decodes(LocalServerState, {
        state: "starting",
        update: { _tag: "updating", from: "0.3.0", to: "0.3.1" },
      }),
    );
    // A version is a release's name, never a path or markup the page would show.
    assert.isFalse(
      decodes(LocalServerState, { ...ready, update: { ...rolledBack, failed: "../0.3.1" } }),
    );
    assert.isFalse(
      decodes(LocalServerState, { ...ready, update: { _tag: "older-app", running: "0.3.0" } }),
    );
  });

  it("refuses an update status that is not one the main process gives", () => {
    const status = (phase: unknown) => ({
      current: "0.0.1-test",
      channel: "stable",
      phase,
      automatic: true,
      launch: "over",
    });
    assert.isTrue(decodes(UpdateStatus, status({ _tag: "idle", checked: false })));
    assert.isTrue(
      decodes(UpdateStatus, status({ _tag: "downloading", version: "0.0.2-test", percent: 41.5 })),
    );
    assert.isTrue(
      decodes(
        UpdateStatus,
        status({ _tag: "downloaded", version: "1.2.3", restart: "waiting-for-save" }),
      ),
    );
    assert.isFalse(
      decodes(UpdateStatus, status({ _tag: "downloading", version: "0.0.2", percent: 101 })),
    );
    assert.isFalse(
      decodes(UpdateStatus, status({ _tag: "downloaded", version: "latest", restart: "offered" })),
    );
    assert.isFalse(
      decodes(UpdateStatus, status({ _tag: "downloaded", version: "1.2.3", restart: "now" })),
    );
    assert.isTrue(decodes(UpdateStatus, status({ _tag: "verifying", version: "0.0.2-test" })));
    assert.isTrue(decodes(UpdateStatus, status({ _tag: "failed", stage: "verify" })));
    assert.isFalse(decodes(UpdateStatus, { ...status({ _tag: "unavailable" }), current: "dev" }));
    assert.isFalse(
      decodes(UpdateStatus, { ...status({ _tag: "idle", checked: false }), channel: "beta" }),
    );
    assert.isFalse(
      decodes(UpdateStatus, { ...status({ _tag: "idle", checked: false }), launch: "later" }),
    );
  });

  it("refuses a request from a page that is not one it may make", () => {
    assert.isTrue(decodes(ConnectRequest, { address: "192.0.2.10:3737" }));
    assert.isFalse(decodes(ConnectRequest, { address: "x".repeat(2049) }));
    assert.isFalse(decodes(ConnectRequest, { address: 3737 }));
    assert.isFalse(decodes(ConnectRequest, null));
    const pairing = { server: "http://192.0.2.10:3737", code: "7KQ2M9XH4D" };
    assert.isTrue(decodes(ConnectRequest, { address: "192.0.2.10:3737", pairing }));
    assert.isFalse(
      decodes(ConnectRequest, { address: "192.0.2.10:3737", pairing: { ...pairing, code: "x" } }),
    );
    assert.isTrue(decodes(OpenRequest, { sealed: "djEwAAAA" }));
    assert.isFalse(decodes(OpenRequest, { sealed: "not base64!" }));
    assert.isFalse(decodes(OpenRequest, { sealed: "" }));
    // Not in base64's canonical form: each decodes, leniently, to no bytes or to other ones.
    assert.isFalse(decodes(OpenRequest, { sealed: "A" }));
    assert.isFalse(decodes(OpenRequest, { sealed: "djEwAAA" }));
    assert.isFalse(decodes(OpenRequest, { sealed: "djEwAAB=" }));
    assert.isTrue(decodes(OpenRequest, { sealed: "djEwAAA=" }));
    assert.isTrue(decodes(SavingReport, { saving: true }));
    assert.isFalse(decodes(SavingReport, { saving: "yes" }));
    assert.isFalse(decodes(SavingReport, true));
  });

  it("finds the bridge only where the preload script put a whole one", () => {
    const call = () => Promise.resolve(null);
    const calls = {
      connect: call,
      forgetServer: call,
      sealToken: call,
      openToken: call,
      networkStatus: call,
      onResumed: call,
      relaunch: call,
      updateStatus: call,
      onUpdate: call,
      checkForUpdates: call,
      restartToUpdate: call,
      cancelRestartToUpdate: call,
      setUpdateChannel: call,
      setAutomaticUpdates: call,
      reportSaving: call,
      notify: call,
      closeNotifications: call,
      onNotificationClick: call,
      onAppLink: call,
      reportLanguage: call,
      reportAppearance: call,
      systemTheme: call,
      reportTray: call,
      onCommand: call,
      reportQuickAccess: call,
      onQuickAccessCue: call,
      hideQuickAccess: call,
      openFromQuickAccess: call,
      quickAccessPicture: call,
      lookingAt: call,
      setLookingAt: call,
      askScreenAccess: call,
      shortcutStatus: call,
      setShortcut: call,
      useThisComputer: call,
      connectToServerInstead: call,
      localDevice: call,
      onLocalServer: call,
      retryLocalServer: call,
      retryServerUpdate: call,
      setPhoneAccess: call,
      onPhoneAccess: call,
      localPairingLink: call,
      setStartWithSystem: call,
      catchSignIn: call,
      expectSignIn: call,
      stopCatchingSignIn: call,
      onSignInReturn: call,
      copySecret: call,
      exportLocal: call,
      runHereAgain: call,
      deleteLocalData: call,
      recordingCheck: call,
      recordingAccess: call,
      startRecording: call,
      openRecorder: call,
      onRecording: call,
      readRecording: call,
      releaseRecording: call,
      recorderJob: call,
      recorderStarted: call,
      recorderChunk: call,
      recorderFrame: call,
      recorderControl: call,
      recorderFailed: call,
      onRecorderCue: call,
    };
    const state = { ...LOCAL_OFF, server: null, pairingCode: null };
    assert.isTrue(decodes(HostedBridge, { state, ...calls }));
    assert.isFalse(decodes(HostedBridge, undefined));
    assert.isFalse(decodes(HostedBridge, { state: { ...state, server: "nowhere" }, ...calls }));
    assert.isFalse(decodes(HostedBridge, { state, ...calls, connect: "yes" }));
    const { notify: _notify, ...withoutNotify } = calls;
    assert.isFalse(decodes(HostedBridge, { state, ...withoutNotify }));
  });

  it("shows a notification only as a page could ask for one: text, a PNG and what it is about", () => {
    const png = pngOf(192, 192);
    const request = {
      entryId: "entry-1",
      title: "Wren",
      body: "The draft is ready.",
      icon: png,
      target: { _tag: "conversation", botId: "bot-wren" },
      pairing: "device-1",
    };
    assert.isTrue(decodes(NotificationRequest, request));
    assert.isTrue(decodes(NotificationRequest, { ...request, icon: null }));
    // Not a PNG: a JPEG's first bytes, a PNG's signature cut short, text.
    assert.isFalse(
      decodes(NotificationRequest, { ...request, icon: new Uint8Array([0xff, 0xd8, 0xff, 0xe0]) }),
    );
    assert.isFalse(decodes(NotificationRequest, { ...request, icon: png.slice(0, 7) }));
    assert.isFalse(
      decodes(NotificationRequest, { ...request, icon: "data:image/png;base64,iVBO" }),
    );
    const huge = new Uint8Array(1024 * 1024 + 1);
    huge.set(png);
    assert.isFalse(decodes(NotificationRequest, { ...request, icon: huge }));
    // A small file whose header declares an image larger than an icon, or none at all.
    for (const [width, height] of [
      [193, 192],
      [192, 65_536],
      [0, 192],
      [0xffff_ffff, 0xffff_ffff],
    ] as const) {
      assert.isFalse(
        decodes(NotificationRequest, { ...request, icon: pngOf(width, height) }),
        `${width}×${height}`,
      );
    }
    assert.isTrue(decodes(NotificationRequest, { ...request, icon: pngOf(48, 192) }));
    // The signature, then another chunk where the header must be.
    const noHeader = pngOf(192, 192);
    noHeader.set([0x49, 0x44, 0x41, 0x54], 12);
    assert.isFalse(decodes(NotificationRequest, { ...request, icon: noHeader }));
    assert.isFalse(decodes(NotificationRequest, { ...request, title: "" }));
    assert.isFalse(decodes(NotificationRequest, { ...request, body: "x".repeat(4097) }));
    assert.isFalse(decodes(NotificationRequest, { ...request, target: { _tag: "settings" } }));
    const { pairing: _pairing, ...unpaired } = request;
    assert.isFalse(decodes(NotificationRequest, unpaired));
  });

  it("hands the page a sign-in's return only from the app's own loopback", () => {
    assert.isTrue(
      decodes(SignInReturn, { url: "http://127.0.0.1:51734/oauth/callback?code=a&state=b" }),
    );
    for (const url of [
      "https://127.0.0.1:51734/oauth/callback?state=b",
      "http://localhost:51734/oauth/callback?state=b",
      "http://127.0.0.1.attacker.example:80/oauth/callback?state=b",
      "http://127.0.0.1:51734/oauth/callback?state=b\nx",
    ]) {
      assert.isFalse(decodes(SignInReturn, { url }), url);
    }
    assert.isTrue(decodes(SignInRelayStart, { _tag: "listening", port: 51734 }));
    assert.isFalse(decodes(SignInRelayStart, { _tag: "listening", port: 80 }));
  });

  it("hands the page a click only with what it was about and the pairing that received it", () => {
    const click = { target: { _tag: "room", roomId: "room-launch" }, pairing: "device-1" };
    assert.isTrue(decodes(NotificationClick, click));
    assert.isFalse(decodes(NotificationClick, { ...click, target: { _tag: "room" } }));
    assert.isFalse(decodes(NotificationClick, { target: click.target }));
    assert.isFalse(decodes(NotificationClick, "j3:notification-click"));
  });

  it("takes as a global shortcut only a key held with Ctrl, Alt, Super or ⌘, written as Electron does", () => {
    for (const accelerator of [
      "CommandOrControl+Shift+J",
      "Control+Alt+Space",
      "Alt+Super+F12",
      "Alt+Shift+1",
    ]) {
      assert.isTrue(decodes(Accelerator, accelerator), accelerator);
    }
    for (const accelerator of [
      "Shift+J",
      "J",
      "Shift+CommandOrControl+J",
      "CommandOrControl+Shift",
      "CommandOrControl+F25",
      "CommandOrControl+j",
      "CommandOrControl+Shift+J+K",
    ]) {
      assert.isFalse(decodes(Accelerator, accelerator), accelerator);
    }
  });

  it("refuses as a global shortcut what one modifier makes, which every other app uses", () => {
    for (const accelerator of [
      "CommandOrControl+C",
      "CommandOrControl+V",
      "CommandOrControl+Z",
      "Control+A",
      "Alt+F4",
      "Super+1",
      // Both are Ctrl outside a Mac.
      "CommandOrControl+Control+X",
    ]) {
      assert.isFalse(decodes(Accelerator, accelerator), accelerator);
    }
  });

  it("lists in the tray what the page reports, within bounds", () => {
    const waiting = { target: { _tag: "conversation", botId: "bot-wren" }, name: "Wren" };
    assert.isTrue(decodes(TrayReport, { pairing: "device-1", count: 1, waiting: [waiting] }));
    assert.isTrue(decodes(TrayReport, { pairing: null, count: 0, waiting: [] }));
    assert.isFalse(decodes(TrayReport, { pairing: "device-1", count: -1, waiting: [] }));
    assert.isFalse(
      decodes(TrayReport, {
        pairing: "device-1",
        count: 11,
        waiting: Array.from({ length: 11 }, () => waiting),
      }),
    );
    assert.isFalse(
      decodes(TrayReport, { pairing: "device-1", count: 1, waiting: [{ ...waiting, name: "" }] }),
    );
  });

  it("hands the page an opening only with the pairing whose roster listed it", () => {
    const target = { _tag: "room", roomId: "room-launch" };
    assert.isTrue(decodes(ShellCommand, { _tag: "open", target, pairing: "device-1" }));
    assert.isFalse(decodes(ShellCommand, { _tag: "open", target }));
    assert.isTrue(decodes(ShellCommand, { _tag: "focus" }));
    assert.isFalse(decodes(ShellCommand, { _tag: "quit" }));
  });

  it("takes from quick access only whether it can show, and a place to open under its pairing", () => {
    assert.isTrue(decodes(QuickAccessReport, { available: true }));
    assert.isFalse(decodes(QuickAccessReport, { available: "yes" }));
    assert.isFalse(decodes(QuickAccessReport, true));
    const opens = (target: unknown) => decodes(QuickAccessOpen, { target, pairing: "device-1" });
    assert.isTrue(opens({ _tag: "conversation", botId: "bot-scout" }));
    assert.isTrue(opens({ _tag: "room", roomId: "room-launch" }));
    assert.isTrue(opens({ _tag: "browser", botId: "bot-scout", tab: "front" }));
    assert.isTrue(opens({ _tag: "pair", botIds: ["bot-scout", "bot-wren"], at: null }));
    assert.isTrue(opens({ _tag: "routine", botId: "bot-scout", routineId: "routine-1" }));
    assert.isTrue(opens({ _tag: "connector", connectorId: "conn_0123456789abcdef" }));
    // Nothing but a place: no address, no pairing left out, no bot unnamed.
    assert.isFalse(opens({ _tag: "page", url: "https://elsewhere.example" }));
    assert.isFalse(
      decodes(QuickAccessOpen, { target: { _tag: "conversation", botId: "bot-scout" } }),
    );
    assert.isFalse(opens({ _tag: "conversation", botId: "" }));
    assert.isFalse(opens({ _tag: "pair", botIds: ["bot-wren", "bot-scout"], at: null }));
    assert.isTrue(decodes(QuickAccessCue, { _tag: "open", opening: 3 }));
    assert.isTrue(decodes(QuickAccessCue, { _tag: "leave" }));
    assert.isFalse(decodes(QuickAccessCue, { _tag: "open" }));
    assert.isFalse(decodes(QuickAccessCue, "open"));
    assert.isTrue(decodes(QuickAccessHide, { opening: 3 }));
    assert.isFalse(decodes(QuickAccessHide, { opening: -1 }));
    assert.isFalse(decodes(QuickAccessHide, undefined));
  });
});

describe("a link to the app", () => {
  const decodeLink = Schema.decodeUnknownExit(AppLinkUrl("j3bots"));
  const opened = (text: string) =>
    Exit.match(decodeLink(text), { onFailure: () => null, onSuccess: (link) => link });

  it("opens a bot's conversation or a room by its id", () => {
    assert.deepStrictEqual(opened("j3bots://bot/bot_4kq2m9xh"), {
      _tag: "open",
      target: { _tag: "conversation", botId: BotId.make("bot_4kq2m9xh") },
    });
    assert.deepStrictEqual(opened("j3bots://room/room%20one/"), {
      _tag: "open",
      target: { _tag: "room", roomId: RoomId.make("room one") },
    });
  });

  it("fills in pairing with a server and a code read as a typed one is", () => {
    const server = encodeURIComponent("https://j3.example.test/");
    assert.deepStrictEqual(opened(`j3bots://pair?server=${server}&code=7kq2-m9xh-4d`), {
      _tag: "pair",
      server: ServerOrigin.make("https://j3.example.test"),
      code: PairingCode.make("7KQ2M9XH4D"),
    });
  });

  it("refuses what is not a link to this build", () => {
    const code = "code=7KQ2M9XH4D";
    for (const text of [
      // Another scheme: a development build's link, the app's own pages, the web.
      "j3bots-dev://bot/bot_1",
      "j3bots://app/bots/bot_1",
      "https://j3.example.test/bots/bot_1",
      // A path beyond the id, an empty id, one too long, one that does not decode.
      "j3bots://bot/bot_1/details",
      "j3bots://bot/",
      "j3bots://bot",
      `j3bots://bot/${"b".repeat(129)}`,
      "j3bots://room/%E0%A4%A",
      // Anything else in the link.
      "j3bots://bot/bot_1?details=true",
      "j3bots://bot/bot_1#top",
      "j3bots://user@bot/bot_1",
      "j3bots://bot:80/bot_1",
      "j3bots://settings",
      // A server that is not an http: or https: origin.
      `j3bots://pair?server=${encodeURIComponent("ftp://j3.example.test")}&${code}`,
      `j3bots://pair?server=${encodeURIComponent("https://j3.example.test/api")}&${code}`,
      `j3bots://pair?server=j3.example.test&${code}`,
      // A code missing, repeated or not a code; a parameter the link does not take.
      `j3bots://pair?server=${encodeURIComponent("https://j3.example.test")}`,
      `j3bots://pair?server=${encodeURIComponent("https://j3.example.test")}&code=12345`,
      `j3bots://pair?server=${encodeURIComponent("https://j3.example.test")}&${code}&${code}`,
      `j3bots://pair?server=${encodeURIComponent("https://j3.example.test")}&${code}&now=1`,
      `j3bots://pair/x?server=${encodeURIComponent("https://j3.example.test")}&${code}`,
      "not a link",
    ]) {
      assert.isNull(opened(text), text);
    }
  });

  it("finds a release's files under the tag the release workflow gives it", () => {
    const repository = "https://github.com/JPSAUD501/j3-bots/releases";
    assert.strictEqual(
      releaseFile("0.4.0", "SHA256SUMS.sig"),
      `${repository}/download/v0.4.0/SHA256SUMS.sig`,
    );
    assert.strictEqual(
      releaseFile("0.4.1-nightly.20261124.57", "J3-Bots-x86_64.AppImage"),
      `${repository}/download/0.4.1-nightly.20261124.57/J3-Bots-x86_64.AppImage`,
    );
    assert.strictEqual(releasePage("0.4.0-rc.1"), `${repository}/tag/v0.4.0-rc.1`);
  });
});
