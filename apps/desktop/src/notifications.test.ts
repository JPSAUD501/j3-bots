// SPDX-License-Identifier: AGPL-3.0-or-later
import { assert, describe, it } from "@effect/vitest";
import { BotId, DeviceId, EntryId, type EntryTarget, RoomId } from "@j3-bots/contracts";
import type { NotificationClick, NotificationRequest } from "@j3-bots/desktop-bridge";
import { makeNotifications } from "./notifications.ts";

const first = DeviceId.make("device-first");
const second = DeviceId.make("device-second");
const conversation: EntryTarget = { _tag: "conversation", botId: BotId.make("bot-wren") };
const room: EntryTarget = { _tag: "room", roomId: RoomId.make("room-launch") };

const request = (
  entry: string,
  pairing: DeviceId,
  target: EntryTarget = conversation,
): NotificationRequest => ({
  entryId: EntryId.make(entry),
  title: "Wren",
  body: "The draft is ready.",
  icon: null,
  target,
  pairing,
});

/**
 * The app's notifications over a fake system screen. `onScreen` lists the
 * entries shown; `clickOf(n)` is the click of the n-th notification ever
 * shown, which the system can still deliver after it left the screen; `opened`
 * is what the page was handed.
 */
const setUp = () => {
  const screen = new Set<string>();
  const clicks: Array<() => void> = [];
  const opened: Array<NotificationClick> = [];
  const notifications = makeNotifications(
    (shown, on) => {
      const key = `${shown.entryId} #${clicks.length}`;
      screen.add(key);
      clicks.push(on.clicked);
      return {
        close: () => {
          if (screen.delete(key)) on.gone();
        },
      };
    },
    (click) => opened.push(click),
  );
  const onScreen = () => [...screen].toSorted();
  const clickOf = (shown: number) => clicks[shown]?.();
  return { notifications, onScreen, clickOf, opened };
};

describe("the desktop app's notifications", () => {
  it("closes a clicked notification and hands the page what it was about and its pairing", () => {
    const { notifications, onScreen, clickOf, opened } = setUp();
    notifications.show(request("entry-1", first, room));
    clickOf(0);
    assert.deepStrictEqual(opened, [{ target: room, pairing: first }]);
    assert.deepStrictEqual(onScreen(), []);
  });

  it("closes what a pairing that ended received, and only that", () => {
    const { notifications, onScreen } = setUp();
    notifications.show(request("entry-1", first));
    notifications.show(request("entry-2", second));
    notifications.closeOf(first);
    assert.deepStrictEqual(onScreen(), ["entry-2 #1"]);
  });

  it("keeps one notification per entry, the latest", () => {
    const { notifications, onScreen, clickOf, opened } = setUp();
    notifications.show(request("entry-1", first, conversation));
    notifications.show(request("entry-1", first, room));
    assert.deepStrictEqual(onScreen(), ["entry-1 #1"]);
    clickOf(1);
    assert.deepStrictEqual(opened, [{ target: room, pairing: first }]);
  });

  it("closes everything as the page goes, and shows the next page's pairing's", () => {
    const { notifications, onScreen } = setUp();
    notifications.show(request("entry-1", first));
    notifications.show(request("entry-2", second));
    notifications.closeAll();
    assert.deepStrictEqual(onScreen(), []);
    notifications.show(request("entry-3", first));
    assert.deepStrictEqual(onScreen(), ["entry-3 #2"]);
  });
});
