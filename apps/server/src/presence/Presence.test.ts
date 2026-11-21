// SPDX-License-Identifier: AGPL-3.0-or-later
import { assert, it } from "@effect/vitest";
import { type BotId, CommandId, type EntryTarget, type Notification } from "@j3-bots/contracts";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { DeviceAuth } from "../auth/DeviceAuth.ts";
import { Bots } from "../bots/Bots.ts";
import { Devices } from "../devices/Devices.ts";
import { Entries, type EntryDraft } from "../entries/Entries.ts";
import { SettingsService } from "../settings/SettingsService.ts";
import * as TestDomain from "../testing/domain.ts";
import { Presence, type Viewer } from "./Presence.ts";

const conversation = (botId: BotId): EntryTarget => ({ _tag: "conversation", botId });

const message = (author: EntryDraft["author"], text: string): EntryDraft => ({
  _tag: "message",
  author,
  text,
  attachments: [],
  mentions: { _tag: "bots", ids: [] },
  delivery: { _tag: "delivered" },
  commandId: null,
});

const add = (botId: BotId, entry: EntryDraft) =>
  Effect.gen(function* () {
    const entries = yield* Entries;
    return yield* entries.append({ target: conversation(botId), entry });
  });

const says = (botId: BotId, text: string) => add(botId, message({ _tag: "bot", botId }, text));

const createBot = (name: string) =>
  Effect.gen(function* () {
    const bots = yield* Bots;
    return yield* bots.create({ commandId: CommandId.make(`create-${name}`), draft: { name } });
  });

const pairDevice = (name: string) =>
  Effect.gen(function* () {
    const devices = yield* Devices;
    const { code } = yield* devices.startPairing;
    return (yield* devices.pair({ code, name })).deviceId;
  });

/** A socket's notifications, as they arrive. */
const listen = (viewer: Viewer) =>
  Effect.gen(function* () {
    const received = yield* Queue.unbounded<Notification>();
    yield* viewer.notifications.pipe(
      Stream.runForEach((notification) => Queue.offer(received, notification)),
      Effect.forkScoped({ startImmediately: true }),
    );
    return received;
  });

/**
 * Two connected sockets, of two devices, each listening. A first entry both
 * are told of shows that both listen, so whatever follows arrives in the
 * order it was added: the next notification taken is the next one sent.
 */
const twoSockets = (botId: BotId) =>
  Effect.gen(function* () {
    const presence = yield* Presence;
    const viewers = [
      yield* presence.connect(yield* pairDevice("Laptop")),
      yield* presence.connect(yield* pairDevice("Desktop")),
    ] as const;
    const queues = [yield* listen(viewers[0]), yield* listen(viewers[1])] as const;
    const first = yield* says(botId, "listening");
    for (const queue of queues) assert.strictEqual((yield* Queue.take(queue)).entryId, first.id);
    return { viewers, queues };
  });

it.effect("notifies every socket of what a bot adds where no socket looks, and nothing else", () =>
  Effect.gen(function* () {
    const scout = yield* createBot("Scout");
    const quill = yield* createBot("Quill");
    const { viewers, queues } = yield* twoSockets(quill.id);
    yield* viewers[0].view(conversation(scout.id));

    // In view on one socket: quiet on both.
    yield* says(scout.id, "Looked into it");
    // The operator's own words, and a turn's work.
    yield* add(quill.id, message({ _tag: "operator" }, "Thanks"));
    yield* add(quill.id, {
      _tag: "work-fold",
      author: { _tag: "bot", botId: quill.id },
      stepCount: 0,
      status: { _tag: "running" },
    });
    const card = yield* add(quill.id, {
      _tag: "question",
      author: { _tag: "bot", botId: quill.id },
      origin: "ask",
      questions: [{ id: "q", prompt: "Ship it?", options: [], acceptsText: true, multiple: false }],
      status: { _tag: "pending" },
    });

    const expected: Notification = {
      target: conversation(quill.id),
      entryId: card.id,
      botId: quill.id,
      kind: "question",
      preview: null,
    };
    for (const queue of queues) assert.deepStrictEqual(yield* Queue.take(queue), expected);

    // The window showing Scout went to the background.
    yield* viewers[0].view(null);
    const back = yield* says(scout.id, "Done");
    for (const queue of queues) {
      const notification = yield* Queue.take(queue);
      assert.deepStrictEqual([notification.entryId, notification.kind], [back.id, "message"]);
    }
  }).pipe(Effect.scoped, Effect.provide(TestDomain.layer)),
);

it.effect(
  "says nothing while the operator has notifications off, and previews only if allowed",
  () =>
    Effect.gen(function* () {
      const settings = yield* SettingsService;
      const scout = yield* createBot("Scout");
      const { queues } = yield* twoSockets(scout.id);
      const [queue] = queues;

      yield* settings.update({
        commandId: CommandId.make("off"),
        changes: { notifications: { enabled: false, previews: true } },
      });
      yield* says(scout.id, "Unheard");
      yield* settings.update({
        commandId: CommandId.make("on"),
        changes: { notifications: { enabled: true, previews: true } },
      });
      const heard = yield* says(scout.id, "  The build is green\nDetails follow");

      const notification = yield* Queue.take(queue);
      assert.deepStrictEqual(
        [notification.entryId, notification.preview],
        [heard.id, "The build is green"],
      );
    }).pipe(Effect.scoped, Effect.provide(TestDomain.layer)),
);

it.effect(
  "tells a device on each of its sockets, leaves one with none to a push, and neither to a revoked one",
  () =>
    Effect.gen(function* () {
      const presence = yield* Presence;
      const scout = yield* createBot("Scout");
      const laptop = yield* pairDevice("Laptop");
      const phone = yield* pairDevice("Phone");
      const tablet = yield* pairDevice("Tablet");
      const queues = [
        yield* listen(yield* presence.connect(laptop)),
        yield* listen(yield* presence.connect(laptop)),
      ];
      yield* presence.connect(tablet);
      yield* (yield* DeviceAuth).revoke(tablet);

      const entry = yield* says(scout.id, "Done");
      const recipients = yield* presence.recipients(conversation(scout.id), entry);
      assert.deepStrictEqual([recipients?.live, recipients?.push], [[laptop], [phone]]);
      for (const queue of queues) assert.strictEqual((yield* Queue.take(queue)).entryId, entry.id);
    }).pipe(Effect.scoped, Effect.provide(TestDomain.layer)),
);

it.effect("tells nobody, by socket or push, of what one device has in view", () =>
  Effect.gen(function* () {
    const presence = yield* Presence;
    const scout = yield* createBot("Scout");
    const laptop = yield* pairDevice("Laptop");
    const phone = yield* pairDevice("Phone");
    const watching = yield* presence.connect(laptop);
    const queue = yield* listen(yield* presence.connect(laptop));
    yield* watching.view(conversation(scout.id));

    const seen = yield* says(scout.id, "Looked into it");
    assert.isNull(yield* presence.recipients(conversation(scout.id), seen));

    // The laptop looks away: the next notification taken is the next entry.
    yield* watching.view(null);
    const unseen = yield* says(scout.id, "Done");
    assert.strictEqual((yield* Queue.take(queue)).entryId, unseen.id);
    const recipients = yield* presence.recipients(conversation(scout.id), unseen);
    assert.deepStrictEqual([recipients?.live, recipients?.push], [[laptop], [phone]]);
  }).pipe(Effect.scoped, Effect.provide(TestDomain.layer)),
);
