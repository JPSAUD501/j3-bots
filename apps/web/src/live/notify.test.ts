// SPDX-License-Identifier: AGPL-3.0-or-later
import { DeviceId } from "@j3-bots/contracts";
import { describe, expect, it } from "vite-plus/test";
import { closeReceivedUnder } from "./notify";

const ended = DeviceId.make("device-ended");
const newer = DeviceId.make("device-newer");

/** A notification on screen, received under `data`'s pairing, that records whether it closed. */
const shown = (data: unknown) => {
  const notification = {
    data,
    closed: false,
    close: () => {
      notification.closed = true;
    },
  };
  return notification;
};

describe("closeReceivedUnder", () => {
  it("closes what the ended pairing received and leaves a newer pairing's", () => {
    const ofEnded = shown({ target: { _tag: "room", roomId: "launch" }, pairing: ended });
    const ofNewer = shown({ target: { _tag: "room", roomId: "launch" }, pairing: newer });
    const unnamed = shown(null);
    closeReceivedUnder([ofEnded, ofNewer, unnamed], ended);
    expect([ofEnded.closed, ofNewer.closed, unnamed.closed]).toEqual([true, false, false]);
  });
});
