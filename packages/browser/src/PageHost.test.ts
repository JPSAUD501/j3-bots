// SPDX-License-Identifier: AGPL-3.0-or-later
import { assert, it } from "@effect/vitest";
import { BrowserHostError, BrowserHostRpcs, BrowserTabRef } from "@j3-bots/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as RpcTest from "effect/rpc/RpcTest";
import * as Stream from "effect/Stream";
import { type PageHost, pageHostHandlers, remotePageHost } from "./PageHost.ts";
import { type FakePageHost, makeFakePageHost } from "./testing/index.ts";

const TAB = BrowserTabRef.make("tab-1");

/** The fake host as the server reaches a host across a connection. */
const overTheWire = <A, E>(use: (host: PageHost, fake: FakePageHost) => Effect.Effect<A, E>) =>
  Effect.gen(function* () {
    const fake = yield* makeFakePageHost();
    const client = yield* RpcTest.makeClient(BrowserHostRpcs).pipe(
      Effect.provide(pageHostHandlers(fake)),
    );
    return yield* use(remotePageHost(client), fake);
  }).pipe(Effect.scoped);

it.effect("refuses a ref the page has changed since, with its reason, across the connection", () =>
  overTheWire((host, fake) =>
    Effect.gen(function* () {
      yield* fake.serve("https://example.test/", {
        title: "Form",
        tree: '- button "Send" [ref=e1]',
      });
      yield* host.open({
        tab: TAB,
        url: "https://example.test/",
        background: false,
        private: false,
      });
      const { tree } = yield* host.snapshot({ tab: TAB, includeImage: false });
      const ref = /\[ref=(\S+)\]/.exec(tree)?.[1];
      assert.isDefined(ref);
      const click = host.act({ tab: TAB, action: { action: "click", locator: `aria-ref=${ref}` } });
      yield* click;
      yield* host.navigate({ tab: TAB, to: { kind: "reload" } });
      assert.deepStrictEqual(
        yield* Effect.flip(click),
        new BrowserHostError({ reason: "stale-ref" }),
      );
      const missing = BrowserTabRef.make("tab-2");
      assert.strictEqual(
        (yield* Effect.flip(host.snapshot({ tab: missing, includeImage: false }))).reason,
        "no-tab",
      );
    }),
  ),
);

it.effect("streams the host's events and a watched tab's pictures across the connection", () =>
  overTheWire((host, fake) =>
    Effect.gen(function* () {
      yield* host.open({ tab: TAB, background: false, private: false });
      const events = yield* host.events.pipe(Stream.take(1), Stream.runCollect, Effect.forkChild);
      const frames = yield* host
        .screencast({ tab: TAB, maxWidth: 640, maxHeight: 480, quality: 60 })
        .pipe(Stream.take(1), Stream.runCollect, Effect.forkChild);
      // Until both calls reach the host, what it sends would be lost.
      const reached = (name: string) =>
        Effect.map(fake.calls, (calls) => calls.some(({ call }) => call === name));
      while (!(yield* reached("host.events")) || !(yield* reached("tab.screencast")))
        yield* Effect.yieldNow;
      yield* fake.emit({ type: "tab.focused", tab: TAB });
      yield* fake.paint(TAB);
      assert.deepStrictEqual(yield* Fiber.join(events), [{ type: "tab.focused", tab: TAB }]);
      const [frame] = yield* Fiber.join(frames);
      assert.deepStrictEqual(frame?.jpeg, new Uint8Array([0xff, 0xd8, 0xff, 0xd9]));
      yield* host.screencastAck({ tab: TAB, frame: frame?.frame ?? -1 });
      assert.deepStrictEqual(yield* fake.acked, [{ tab: TAB, frame: 1 }]);
    }),
  ),
);

it.effect(
  "hands a bot's download over once, and takes a file for an upload, across the connection",
  () =>
    overTheWire((host, fake) =>
      Effect.gen(function* () {
        yield* host.open({ tab: TAB, background: false, private: false });
        const { path } = yield* host.putFile({
          tab: TAB,
          name: "invoice.pdf",
          bytes: new Uint8Array([1, 2]),
        });
        assert.deepStrictEqual((yield* fake.files).get(path), new Uint8Array([1, 2]));
        const download = yield* fake.download(TAB, "menu.pdf", new Uint8Array([3]));
        assert.deepStrictEqual((yield* host.takeDownload({ download })).bytes, new Uint8Array([3]));
        assert.strictEqual(
          (yield* Effect.flip(host.takeDownload({ download }))).reason,
          "invalid-target",
        );
      }),
    ),
);
