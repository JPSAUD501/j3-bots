// SPDX-License-Identifier: AGPL-3.0-or-later
import { assert, describe, it } from "@effect/vitest";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import {
  ConnectRequest,
  ConnectResult,
  DesktopState,
  HostedBridge,
  NotificationClick,
  NotificationRequest,
  OpenRequest,
  SavingReport,
  UpdateStatus,
} from "./index.ts";

const decodes = <S extends Schema.Constraint & { readonly DecodingServices: never }>(
  schema: S,
  input: unknown,
) => Exit.isSuccess(Schema.decodeUnknownExit(schema)(input));

describe("the desktop bridge", () => {
  it("keeps only a bare http: or https: origin as the server", () => {
    for (const server of [
      "http://192.0.2.10:3737",
      "https://j3.example.test",
      "http://[::1]:3737",
    ]) {
      assert.isTrue(decodes(DesktopState, { server }), server);
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
      assert.isFalse(decodes(DesktopState, { server }), server);
    }
    assert.isTrue(decodes(DesktopState, { server: null }));
    assert.isFalse(decodes(DesktopState, {}));
  });

  it("refuses an answer from the main process that is not one it gives", () => {
    assert.isTrue(decodes(ConnectResult, { _tag: "connected", server: "http://192.0.2.10:3737" }));
    assert.isTrue(decodes(ConnectResult, { _tag: "refused", reason: "needs-https" }));
    assert.isFalse(decodes(ConnectResult, { _tag: "connected", server: "http://192.0.2.10/x" }));
    assert.isFalse(decodes(ConnectResult, { _tag: "refused", reason: "because" }));
    assert.isFalse(decodes(ConnectResult, { _tag: "paired" }));
    assert.isFalse(decodes(ConnectResult, "connected"));
  });

  it("refuses an update status that is not one the main process gives", () => {
    const status = (phase: unknown) => ({ current: "0.0.1-test", phase });
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
    assert.isFalse(decodes(UpdateStatus, { current: "dev", phase: { _tag: "unavailable" } }));
  });

  it("refuses a request from a page that is not one it may make", () => {
    assert.isTrue(decodes(ConnectRequest, { address: "192.0.2.10:3737" }));
    assert.isFalse(decodes(ConnectRequest, { address: "x".repeat(2049) }));
    assert.isFalse(decodes(ConnectRequest, { address: 3737 }));
    assert.isFalse(decodes(ConnectRequest, null));
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
      reportSaving: call,
      notify: call,
      closeNotifications: call,
      onNotificationClick: call,
    };
    const state = { server: null };
    assert.isTrue(decodes(HostedBridge, { state, ...calls }));
    assert.isFalse(decodes(HostedBridge, undefined));
    assert.isFalse(decodes(HostedBridge, { state: { ...state, server: "nowhere" }, ...calls }));
    assert.isFalse(decodes(HostedBridge, { state, ...calls, connect: "yes" }));
    const { notify: _notify, ...withoutNotify } = calls;
    assert.isFalse(decodes(HostedBridge, { state, ...withoutNotify }));
  });

  it("shows a notification only as a page could ask for one: text, a PNG and what it is about", () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
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
    assert.isFalse(decodes(NotificationRequest, { ...request, title: "" }));
    assert.isFalse(decodes(NotificationRequest, { ...request, body: "x".repeat(4097) }));
    assert.isFalse(decodes(NotificationRequest, { ...request, target: { _tag: "settings" } }));
    const { pairing: _pairing, ...unpaired } = request;
    assert.isFalse(decodes(NotificationRequest, unpaired));
  });

  it("hands the page a click only with what it was about and the pairing that received it", () => {
    const click = { target: { _tag: "room", roomId: "room-launch" }, pairing: "device-1" };
    assert.isTrue(decodes(NotificationClick, click));
    assert.isFalse(decodes(NotificationClick, { ...click, target: { _tag: "room" } }));
    assert.isFalse(decodes(NotificationClick, { target: click.target }));
    assert.isFalse(decodes(NotificationClick, "j3:notification-click"));
  });
});
