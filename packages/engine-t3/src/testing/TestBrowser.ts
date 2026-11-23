// SPDX-License-Identifier: AGPL-3.0-or-later
import type { BrowserInput } from "@j3-bots/contracts";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Latch from "effect/Latch";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import {
  BrowserBridge,
  type EngineBrowserTab,
  type ViewerClosed,
  type ViewerOutput,
} from "../Browser.ts";
import { EngineUnavailable } from "../errors.ts";
import type { EngineTabId } from "../ids.ts";

/** One viewer the server opened, as the engine's end of it. */
export interface FakeViewer {
  readonly tab: EngineTabId;
  readonly size: {
    readonly maxWidth: number;
    readonly maxHeight: number;
    readonly quality: number;
  };
  /** Sends the viewer one output, as the engine would. */
  readonly emit: (output: ViewerOutput) => Effect.Effect<void>;
  /** Ends the viewer's output, as the engine closing the stream would. */
  readonly close: (closed: ViewerClosed) => Effect.Effect<void>;
  /** How many frames the server acknowledged so far. */
  readonly acks: Effect.Effect<number>;
  /** The input the server passed on, in order. */
  readonly inputs: Effect.Effect<ReadonlyArray<BrowserInput>>;
  /** Completes once the server let the viewer go, which closes it in the engine. */
  readonly released: Effect.Effect<void>;
  readonly isReleased: Effect.Effect<boolean>;
}

/** What a test does as the engine's browser. */
export class TestBrowserControl extends Context.Service<
  TestBrowserControl,
  {
    /** The tabs bots have open from now on. */
    readonly setTabs: (tabs: ReadonlyArray<EngineBrowserTab>) => Effect.Effect<void>;
    /** The next viewer the server opens, once it has. */
    readonly nextViewer: Effect.Effect<FakeViewer>;
    /** Whether a viewer can be opened: the engine is ready. */
    readonly setAvailable: (available: boolean) => Effect.Effect<void>;
    /**
     * Whether an open is held once the engine's end of the viewer exists, before
     * the server gets its viewer: the time a real engine takes to answer.
     */
    readonly holdOpens: (held: boolean) => Effect.Effect<void>;
    /** How many viewers the server opened so far, held ones included. */
    readonly opens: Effect.Effect<number>;
  }
>()("@j3-bots/engine-t3/testing/TestBrowser/TestBrowserControl") {}

/**
 * An in-memory `BrowserBridge` and its control. Tabs are what the test sets;
 * each viewer is a `FakeViewer` the test drives. Viewers count nothing on their
 * own: control changes hands only when the test emits a `control` output.
 */
export const layer = Layer.effectContext(
  Effect.gen(function* () {
    const tabs = yield* SubscriptionRef.make<ReadonlyArray<EngineBrowserTab>>([]);
    const opened = yield* Queue.unbounded<FakeViewer>();
    const available = yield* Ref.make(true);
    const answering = yield* Latch.make(true);
    const opens = yield* Ref.make(0);

    const openViewer = Effect.fn("TestBrowser.openViewer")(function* (input: {
      readonly tab: EngineTabId;
      readonly maxWidth: number;
      readonly maxHeight: number;
      readonly quality: number;
    }) {
      if (!(yield* Ref.get(available))) return yield* new EngineUnavailable();
      yield* Ref.update(opens, (count) => count + 1);
      const output = yield* Queue.unbounded<ViewerOutput, ViewerClosed>();
      const acks = yield* Ref.make(0);
      const inputs = yield* Ref.make<ReadonlyArray<BrowserInput>>([]);
      const released = yield* Deferred.make<void>();
      yield* Effect.addFinalizer(() => Deferred.succeed(released, undefined));
      const { tab, ...size } = input;
      yield* Queue.offer(opened, {
        tab,
        size,
        emit: (next) => Queue.offer(output, next).pipe(Effect.asVoid),
        close: (closed) => Queue.fail(output, closed).pipe(Effect.asVoid),
        acks: Ref.get(acks),
        inputs: Ref.get(inputs),
        released: Deferred.await(released),
        isReleased: Deferred.isDone(released),
      });
      yield* answering.await;
      return {
        output: Stream.fromQueue(output),
        ack: Ref.update(acks, (count) => count + 1),
        send: (next: BrowserInput) => Ref.update(inputs, (all) => [...all, next]),
      };
    });

    return Context.make(
      BrowserBridge,
      BrowserBridge.of({ tabs: () => SubscriptionRef.changes(tabs), openViewer }),
    ).pipe(
      Context.add(
        TestBrowserControl,
        TestBrowserControl.of({
          setTabs: (next) => SubscriptionRef.set(tabs, next),
          nextViewer: Queue.take(opened),
          setAvailable: (next) => Ref.set(available, next),
          holdOpens: (held) => (held ? answering.close : answering.open).pipe(Effect.asVoid),
          opens: Ref.get(opens),
        }),
      ),
    );
  }),
);
