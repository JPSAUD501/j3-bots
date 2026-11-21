// SPDX-License-Identifier: AGPL-3.0-or-later
import type { DeviceCredential } from "@j3-bots/client-runtime";
import { DeviceId, DeviceToken } from "@j3-bots/contracts";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import { describe, expect, it } from "vite-plus/test";
import { credentialRecord } from "./storedCredential";

const credential = {
  deviceId: DeviceId.make("device-1"),
  token: Redacted.make(DeviceToken.make("t".repeat(32))),
};
const DESKTOP_PAGE = "j3bots://app";
const serverA = new URL("http://192.168.1.20:3737");
const serverB = new URL("https://bots.example.com");

const deviceOf = (found: Option.Option<DeviceCredential>) =>
  Option.map(found, ({ deviceId, token }) => ({ deviceId, token: Redacted.value(token) }));

describe("credentialRecord", () => {
  it("reads a credential back for the server that issued it", () => {
    const record = credentialRecord(serverA, DESKTOP_PAGE);
    expect(deviceOf(record.read(record.write(credential)))).toEqual(
      Option.some({ deviceId: credential.deviceId, token: "t".repeat(32) }),
    );
  });

  it("does not read a credential saved for server A as server B's", () => {
    const stored = credentialRecord(serverA, DESKTOP_PAGE).write(credential);
    expect(credentialRecord(serverB, DESKTOP_PAGE).read(stored)).toEqual(Option.none());
  });

  it("reads a browser's record without a server as the page's own server's", () => {
    const legacy = JSON.stringify({ deviceId: "device-1", token: "t".repeat(32) });
    const page = "https://bots.example.com";
    expect(Option.isSome(credentialRecord(new URL(page), page).read(legacy))).toBe(true);
  });

  it("does not read a record without a server in the desktop app", () => {
    const legacy = JSON.stringify({ deviceId: "device-1", token: "t".repeat(32) });
    expect(credentialRecord(serverA, DESKTOP_PAGE).read(legacy)).toEqual(Option.none());
  });
});
