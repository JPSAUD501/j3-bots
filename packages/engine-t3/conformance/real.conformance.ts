// SPDX-License-Identifier: AGPL-3.0-or-later
// @effect-diagnostics nodeBuiltinImport:off -- the harness finds and kills the engine process it started.
import * as NodeProcess from "node:process";
import { ModelId, ProviderId } from "@j3-bots/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it, layer } from "@effect/vitest";
import { CommandId, MessageId, ThreadId } from "@t3tools/contracts";
import type * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import { Engine, type EngineOptions } from "../src/Engine.ts";
import { isBackgroundWorkPending, type SessionEvent } from "../src/events.ts";
import { IdempotencyKey, SyncToken, type TurnId } from "../src/ids.ts";
import { makeEngineRpc } from "../src/t3/Connection.ts";
import { ensureCredential } from "../src/t3/Credential.ts";
import { ensureInstalled } from "../src/t3/Install.ts";
import { makePrivateFiles } from "../src/t3/PrivateFiles.ts";
import { layer as engineLayer } from "../src/t3/T3Engine.ts";
import { workInShell } from "../src/t3/Translate.ts";
import { type Act, Bench } from "./Bench.ts";
import { scenarios, turnOf } from "./scenarios.ts";

// The conformance scenarios against the real adapter, over the pinned engine
// running the scripted ACP agent. Run with `pnpm --filter @j3-bots/engine-t3
// test:conformance`. It downloads the pinned engine once into
// `$J3_CONFORMANCE_HOME/engine` and starts it on port 3791.

const PORT = 3791;
const PROVIDER = ProviderId.make("scripted");

const directive = (act: Act) => {
  switch (act._tag) {
    case "reply":
      return "[[script:plain]]";
    case "work":
      return "[[script:slow every=500 for=120000]]";
    case "approval":
    case "question":
    case "secret":
    case "delegate":
      return `[[script:${act._tag}]]`;
    case "speak":
      return `[[script:speak text=${act.text}]]`;
  }
};

const paths = Effect.gen(function* () {
  const path = yield* Path.Path;
  const root = yield* Config.NonEmptyString("J3_CONFORMANCE_HOME");
  const agent = path.join(path.dirname(yield* path.fromFileUrl(new URL(import.meta.url))), "..");
  return {
    home: path.join(root, "engine"),
    workspace: path.join(root, "workspace"),
    sharedSkills: path.join(root, "shared-skills"),
    agent: path.join(agent, "scripted-agent", "agent.ts"),
  };
});

const options = Effect.map(paths, ({ home, agent, sharedSkills }): EngineOptions => ({
  home,
  port: PORT,
  binaryOverride: Option.none(),
  providers: [
    {
      id: PROVIDER,
      name: "Scripted agent",
      harness: "acp-command",
      command: NodeProcess.execPath,
      args: [agent],
      environment: [],
    },
  ],
  // The scripted agent calls no bot tools.
  toolBridge: { command: "true", args: [] },
  systemPromptFile: ".j3/system.md",
  // Only Codex reads it, and the bench runs no Codex instance.
  basePrompt: Stream.make(""),
  // Only Claude Code and Codex list skills, and the bench runs neither.
  sharedSkills,
  // The bench's home is a fresh folder of its own, with no web client to publish through.
  isPrivate: () => Effect.succeed(true),
}));

const platform = Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer);

const realEngine = Layer.unwrap(Effect.map(options, engineLayer));

/** Waits until the engine takes commands, as the server does before it sends any. */
const engineReady = Engine.use((engine) =>
  engine.status.pipe(
    Stream.takeUntil((status) => status.state._tag === "ready"),
    Stream.runDrain,
  ),
);

/** A second connection to the engine, as another of its clients. */
const foreignRpc = Effect.gen(function* () {
  const { home } = yield* paths;
  const files = yield* makePrivateFiles(() => Effect.succeed(true)).pipe(
    Effect.provide(SecureRandom.layerWebCrypto),
  );
  const executable = yield* ensureInstalled({
    home,
    platform: NodeProcess.platform,
    arch: NodeProcess.arch,
    files,
  });
  const { token } = yield* ensureCredential({ executable, home, files });
  return yield* makeEngineRpc({ port: PORT, token: Effect.succeed(token) });
});

const bench = Layer.effect(
  Bench,
  Effect.gen(function* () {
    yield* engineReady;
    const { workspace } = yield* paths;
    const run = yield* Clock.currentTimeMillis;
    const rpc = yield* foreignRpc;
    let foreign = 0;

    return Bench.of({
      workspacePath: workspace,
      model: { providerId: PROVIDER, modelId: ModelId.make("scripted") },
      key: (name) => IdempotencyKey.make(`${run}-${name}`),
      prompt: directive,
      // The scripted agent follows its prompt and reads a steer as soon as it arrives.
      perform: Effect.fn("Bench.perform")(() => Effect.void),
      readSteers: Effect.fn("Bench.readSteers")(() => Effect.void),
      startForeignTurn: Effect.fn("Bench.startForeignTurn")(function* (sessionId) {
        const id = `conformance-foreign-${run}-${foreign++}`;
        yield* rpc["orchestration.dispatchCommand"]({
          type: "message.dispatch",
          commandId: CommandId.make(id),
          threadId: ThreadId.make(sessionId),
          messageId: MessageId.make(id),
          text: directive({ _tag: "reply" }),
          attachments: [],
          dispatchMode: { type: "start_immediately" },
          createdBy: "user",
          creationSource: "web",
        }).pipe(Effect.orDie);
      }),
    });
  }),
);

describe("Engine conformance", () => {
  layer(bench.pipe(Layer.provideMerge(realEngine), Layer.provideMerge(platform)), {
    timeout: "10 minutes",
    excludeTestServices: true,
  })("real engine", scenarios);
});

/** Kills the engine process serving `home`, as a crash would. */
const killEngine = Effect.fnUntraced(function* (home: string) {
  const fs = yield* FileSystem.FileSystem;
  for (const entry of yield* fs.readDirectory("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    const commandLine = yield* fs
      .readFileString(`/proc/${entry}/cmdline`)
      .pipe(Effect.orElseSucceed(() => ""));
    const args = commandLine.split("\0");
    if (args.includes("serve") && args.includes(home)) {
      NodeProcess.kill(Number(entry), "SIGKILL");
      return;
    }
  }
  return yield* Effect.die(new Error("No engine process to kill"));
});

const take = (queue: Queue.Dequeue<SessionEvent, Cause.Done>) =>
  Queue.take(queue).pipe(Effect.orDie);

const isTagged = <T extends SessionEvent["_tag"]>(
  event: SessionEvent,
  tag: T,
): event is Extract<SessionEvent, { readonly _tag: T }> => event._tag === tag;

/** Takes events until one is `tag` and matches, and returns it. */
const until = Effect.fnUntraced(function* <T extends SessionEvent["_tag"]>(
  queue: Queue.Dequeue<SessionEvent, Cause.Done>,
  tag: T,
  match: (event: Extract<SessionEvent, { readonly _tag: T }>) => boolean = () => true,
) {
  while (true) {
    const event = yield* take(queue);
    if (isTagged(event, tag) && match(event)) return event;
  }
});

const openWatched = Effect.fnUntraced(function* (name: string) {
  const engine = yield* Engine;
  const bench = yield* Bench;
  const projectId = yield* engine.ensureProject({
    workspacePath: bench.workspacePath,
    title: name,
  });
  const sessionId = yield* engine.openSession({
    key: bench.key(`session-${name}`),
    projectId,
    title: name,
    model: bench.model,
    permissionMode: "supervised",
  });
  const queue = yield* engine
    .events({ sessionId, after: null })
    .pipe(Stream.orDie, Stream.toQueue({ capacity: "unbounded" }));
  const first = yield* until(queue, "replaced");
  return { sessionId, queue, start: first.cursor };
});

describe("Engine conformance, real engine only", () => {
  it.live(
    "reads a settled thread's pending background work from its shell",
    () =>
      Effect.gen(function* () {
        const engine = yield* Engine;
        const bench = yield* Bench;
        const { sessionId, queue } = yield* openWatched("shell");
        const reply = yield* engine.dispatch({
          key: bench.key("shell-reply"),
          sessionId,
          text: directive({ _tag: "reply" }),
          attachments: [],
          delivery: { _tag: "start", freshContext: false },
        });
        yield* until(queue, "turn-finished", (event) => event.turnId === turnOf(reply));

        // What the adapter asks for undecidable tools (`reportedWork`).
        const rpc = yield* foreignRpc;
        const threadId = ThreadId.make(sessionId);
        const { threads } = yield* rpc["orchestration.getThreadFamily"]({ threadId });
        const shell = threads.find((thread) => thread.id === threadId);

        assert.isDefined(shell);
        assert.deepStrictEqual(workInShell(shell, [{ taskId: "no-such-task", turnId: null }]), []);
      }).pipe(
        Effect.provide(bench.pipe(Layer.provideMerge(realEngine), Layer.provideMerge(platform))),
      ),
    { timeout: 120_000 },
  );

  it.live(
    "attributes a delegated task still running to the turn that delegated it, until Stop",
    () =>
      Effect.gen(function* () {
        const engine = yield* Engine;
        const bench = yield* Bench;
        const { sessionId, queue } = yield* openWatched("delegated-work");
        const delegating = yield* engine.dispatch({
          key: bench.key("delegated-work"),
          sessionId,
          text: "[[script:delegate child=slow]]",
          attachments: [],
          delivery: { _tag: "start", freshContext: false },
        });
        const delegated = yield* until(
          queue,
          "turn-finished",
          (event) => event.turnId === turnOf(delegating),
        );
        const synchronized = Effect.fnUntraced(function* (name: string) {
          const token = SyncToken.make(bench.key(name));
          yield* engine.synchronize({ sessionId, token });
          return yield* until(queue, "synchronized", (event) => event.token === token);
        });
        const running = yield* synchronized("delegated-work-running");

        yield* engine.stop({ key: bench.key("delegated-work-stop"), sessionId });
        let stopped = yield* synchronized("delegated-work-stopped-0");
        for (
          let round = 1;
          (isBackgroundWorkPending(stopped.backgroundWork) || stopped.runnableTurns.length > 0) &&
          round < 20;
          round++
        ) {
          yield* Effect.sleep("500 millis");
          stopped = yield* synchronized(`delegated-work-stopped-${round}`);
        }

        assert.isTrue(delegated.backgroundWork);
        assert.deepStrictEqual(running.backgroundWork, {
          turns: [turnOf(delegating)],
          unattributed: false,
          stoppable: true,
        });
        // Stop ended the task, and left nothing to run in its place.
        assert.deepStrictEqual(stopped.backgroundWork, {
          turns: [],
          unattributed: false,
          stoppable: false,
        });
        assert.deepStrictEqual(stopped.runnableTurns, []);
      }).pipe(
        Effect.provide(bench.pipe(Layer.provideMerge(realEngine), Layer.provideMerge(platform))),
      ),
    { timeout: 120_000 },
  );

  it.live(
    "survives an engine restart: the cut turn stays interrupted, the held queue resumes once",
    () =>
      Effect.gen(function* () {
        const engine = yield* Engine;
        const bench = yield* Bench;
        const { home } = yield* paths;
        const { sessionId, queue } = yield* openWatched("restart");
        const running = yield* engine.dispatch({
          key: bench.key("restart-work"),
          sessionId,
          text: "[[script:slow every=500 for=20000]]",
          attachments: [],
          delivery: { _tag: "start", freshContext: false },
        });
        yield* until(queue, "turn-started");
        // A turn waiting behind it, which the restart holds.
        yield* bench.startForeignTurn(sessionId);

        yield* killEngine(home);
        // The engine holds the queue as it recovers, before or after it ends the cut turn.
        let end: Extract<SessionEvent, { readonly _tag: "turn-finished" }> | undefined;
        let held: Extract<SessionEvent, { readonly _tag: "queue-held" }> | undefined;
        while (end === undefined || held === undefined) {
          const event = yield* take(queue);
          if (isTagged(event, "turn-finished") && event.turnId === turnOf(running)) end = event;
          if (isTagged(event, "queue-held")) held = event;
        }
        yield* engineReady;
        yield* engine.resumeQueue({ sessionId, hold: held.cursor });
        const waiting = yield* until(queue, "turn-started");
        yield* until(queue, "turn-finished", (event) => event.turnId === waiting.turnId);
        const after = yield* engine.dispatch({
          key: bench.key("restart-reply"),
          sessionId,
          text: directive({ _tag: "reply" }),
          attachments: [],
          delivery: { _tag: "start", freshContext: false },
        });
        const next = yield* until(
          queue,
          "turn-finished",
          (event) => event.turnId === turnOf(after),
        );

        // Provisioned not to continue turns after its restart, the engine ends the cut turn.
        assert.deepStrictEqual(end.outcome, {
          _tag: "interrupted",
        });
        assert.deepStrictEqual(next.outcome, {
          _tag: "completed",
        });
        assert.deepStrictEqual(waiting.cause, {
          _tag: "background",
          origin: null,
        });
      }).pipe(
        Effect.provide(bench.pipe(Layer.provideMerge(realEngine), Layer.provideMerge(platform))),
      ),
    { timeout: 180_000 },
  );

  it.live(
    "tells a replay the engine answers with a snapshot as a replacement with its history",
    () =>
      Effect.gen(function* () {
        const engine = yield* Engine;
        const bench = yield* Bench;
        const { sessionId, queue, start } = yield* openWatched("snapshot-resume");
        // More stored events than the engine replays (128, **Read** at
        // `db51b67`, `ThreadStream.ts`): a resume from before them gets a
        // snapshot. A short turn stores about 30; streamed text adds none.
        const turns: Array<TurnId> = [];
        for (let index = 0; index < 6; index++) {
          const reply = yield* engine.dispatch({
            key: bench.key(`snapshot-resume-reply-${index}`),
            sessionId,
            text: directive({ _tag: "reply" }),
            attachments: [],
            delivery: { _tag: "start", freshContext: false },
          });
          yield* until(queue, "turn-finished", (event) => event.turnId === turnOf(reply));
          turns.push(turnOf(reply));
        }

        const resumed = yield* engine
          .events({ sessionId, after: start })
          .pipe(Stream.orDie, Stream.toQueue({ capacity: "unbounded" }));
        const first = yield* take(resumed);

        assert.strictEqual(first._tag, "replaced");
        if (first._tag !== "replaced") return;
        assert.deepStrictEqual(first.openTurns, []);
        assert.deepStrictEqual(
          turns.filter((turnId) => first.endedTurns.some((turn) => turn.turnId === turnId)),
          turns,
        );
      }).pipe(
        Effect.provide(bench.pipe(Layer.provideMerge(realEngine), Layer.provideMerge(platform))),
      ),
    { timeout: 120_000 },
  );

  it.live(
    "answers for its keys and resumes by replacement after the server restarts",
    () =>
      Effect.gen(function* () {
        const engines = bench.pipe(Layer.provideMerge(realEngine), Layer.provideMerge(platform));
        // The first server process: a turn, then the server stops with the engine.
        const first = yield* Effect.gen(function* () {
          const engine = yield* Engine;
          const bench = yield* Bench;
          const { sessionId, queue } = yield* openWatched("server-restart");
          const dispatch = {
            key: bench.key("server-restart-reply"),
            sessionId,
            text: directive({ _tag: "reply" }),
            attachments: [],
            delivery: { _tag: "start", freshContext: false },
          } as const;
          const disposition = yield* engine.dispatch(dispatch);
          const started = yield* until(queue, "turn-started");
          yield* until(queue, "turn-finished", (event) => event.turnId === turnOf(disposition));
          // The turn ends after this cursor, so a replacement must list it.
          return { dispatch, disposition, sessionId, cursor: started.cursor };
        }).pipe(Effect.scoped, Effect.provide(engines));

        // A new server process knows nothing of the first one's streams.
        const second = yield* Effect.gen(function* () {
          const engine = yield* Engine;
          yield* engine.redispatch(first.dispatch);
          const queue = yield* engine
            .events({ sessionId: first.sessionId, after: first.cursor })
            .pipe(Stream.orDie, Stream.toQueue({ capacity: "unbounded" }));
          const resumed = yield* take(queue);
          return { resumed };
        }).pipe(Effect.scoped, Effect.provide(engines));

        assert.strictEqual(first.disposition._tag, "started");
        assert.strictEqual(second.resumed._tag, "replaced");
        if (second.resumed._tag !== "replaced") return;
        assert.deepStrictEqual(second.resumed.openTurns, []);
        assert.isTrue(
          second.resumed.endedTurns.some((turn) => turn.turnId === turnOf(first.disposition)),
        );
      }),
    { timeout: 240_000 },
  );
});
