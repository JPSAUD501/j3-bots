// SPDX-License-Identifier: AGPL-3.0-or-later
// @effect-diagnostics nodeBuiltinImport:off -- the harness finds and kills the engine process it started.
import * as NodeHttp from "node:http";
import * as NodeProcess from "node:process";
import { ModelId, ProviderId } from "@j3-bots/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it, layer } from "@effect/vitest";
import { CommandId, MessageId, ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import type * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import { BrowserBridge, type ViewerOutput } from "../src/Browser.ts";
import { Engine, type EngineOptions } from "../src/Engine.ts";
import { EngineUnavailable } from "../src/errors.ts";
import { isBackgroundWorkPending, type SessionEvent } from "../src/events.ts";
import { IdempotencyKey, SessionId, SyncToken, type TurnId } from "../src/ids.ts";
import { makeEngineRpc } from "../src/t3/Connection.ts";
import { ensureCredential } from "../src/t3/Credential.ts";
import { ensureInstalled } from "../src/t3/Install.ts";
import { threadIdFor } from "../src/t3/Keys.ts";
import { pin } from "../src/t3/Pin.ts";
import { engineFolders, makePrivateFiles } from "../src/t3/PrivateFiles.ts";
import { instanceIdFor } from "../src/t3/Provision.ts";
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

/**
 * Set when the engine's machine has an administrator's policy that limits
 * threads to Supervised (`"limits": { "maxRuntimeMode": "approval-required" }`).
 * The engine reads it only from a system path that only root can write, so
 * only a run set up for it has one (`with-policy.sh`,
 * `pnpm test:conformance:policy`), and every other run skips what needs it.
 */
const SUPERVISED_ONLY = NodeProcess.env["J3_CONFORMANCE_SUPERVISED_ONLY"] === "1";

/**
 * The policy's file, which a policy run hands to the suite's user in its
 * private mount namespace, so a case can take the policy away and put it back
 * between two starts of the engine (`with-policy.sh`).
 */
const POLICY_FILE = Config.NonEmptyString("J3_CONFORMANCE_POLICY_FILE");

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
  // A bridge that answers nothing: the scripted agent lists no bot tools, so
  // it speaks through the engine's own `send_to_user`, which the suite checks.
  toolBridge: {
    command: "true",
    args: [],
    environment: [],
    preApproved: ["say"],
    callTimeoutSeconds: 720,
  },
  systemPromptFile: ".j3/system.md",
  // Only Codex reads it, and the bench runs no Codex instance.
  basePrompt: Stream.make(""),
  suggestReplies: Stream.make(false),
  // Only Claude Code and Codex list skills, and the bench runs neither.
  sharedSkills,
  botSkills: "skills",
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
    sha256: pin.sha256,
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

/**
 * Kills the engine, as a crash would, and waits until the adapter has started
 * it again: its status leaves `ready`, then returns. Its connection may still
 * be on its way back (`onceReachable`).
 */
const restartEngine = Effect.fnUntraced(function* (home: string) {
  const engine = yield* Engine;
  const ready = yield* engine.status.pipe(
    Stream.map((status) => status.state._tag === "ready"),
    Stream.toQueue({ capacity: "unbounded" }),
  );
  yield* killEngine(home);
  let down = false;
  while (true) {
    const now = yield* Queue.take(ready).pipe(Effect.orDie);
    if (!now) down = true;
    else if (down) return;
  }
});

/**
 * `effect`, sent again while the engine is unreachable, which sends nothing:
 * once the engine reports ready again after a restart, its connection may
 * still be on its way back.
 */
const onceReachable = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.retry({
      while: Schema.is(EngineUnavailable),
      schedule: Schedule.spaced("250 millis"),
      times: 120,
    }),
  );

/** The error `effect` fails with; its success fails the case, naming the call. */
const refusedWith = <A, E, R>(effect: Effect.Effect<A, E, R>, call: string) =>
  effect.pipe(
    Effect.matchEffect({
      onSuccess: () =>
        Effect.sync(() => assert.fail(`The engine accepted ${call}, which it was to refuse`)),
      onFailure: (error) => Effect.succeed(error),
    }),
  );

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

/**
 * Reads the host's speech in a session's events, the uses its `replaced`
 * events carry included, each once: `next(count)` gives the text of the next
 * `count` uses.
 */
const speechReader = (queue: Queue.Dequeue<SessionEvent, Cause.Done>) => {
  const seen = new Set<string>();
  return Effect.fnUntraced(function* (count: number) {
    const spoken: Array<string> = [];
    while (spoken.length < count) {
      const event = yield* take(queue);
      const heard = isTagged(event, "replaced")
        ? event.hostSpeech
        : isTagged(event, "host-speech")
          ? [event]
          : [];
      for (const speech of heard) {
        if (seen.has(speech.speechId)) continue;
        seen.add(speech.speechId);
        spoken.push(speech.text);
      }
    }
    return spoken;
  });
};

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
  return { sessionId, projectId, queue, start: first.cursor };
});

/**
 * A page for the engine's browser, on a loopback port: one text field across
 * its top left corner, which reports each change of its text back here.
 */
const testPage = Effect.acquireRelease(
  Effect.callback<{
    readonly url: string;
    readonly typed: () => string;
    readonly server: NodeHttp.Server;
  }>((resume) => {
    let typed = "";
    const server = NodeHttp.createServer((request, response) => {
      if (request.method === "POST" && request.url === "/typed") {
        let body = "";
        request.setEncoding("utf8");
        request.on("data", (chunk: string) => {
          body += chunk;
        });
        request.on("end", () => {
          typed = body;
          response.writeHead(204).end();
        });
        return;
      }
      // The page repaints on its own. The engine sends a new viewer one still of
      // an idle page and drops it silently when the capture fails, after which
      // an idle page sends nothing until it repaints (Read at 59651c1,
      // `ServerBrowser.ts` L3300-3314 and L3369-3371). This case is about the
      // stream, not that still.
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(
        `<!doctype html><title>Conformance page</title>
<input id="field" style="position:absolute;left:0;top:0;width:600px;height:200px;font-size:40px">
<p id="clock" style="position:absolute;left:0;top:220px"></p>
<script>
  const field = document.getElementById("field");
  field.addEventListener("input", () => fetch("/typed", { method: "POST", body: field.value }));
  const clock = document.getElementById("clock");
  setInterval(() => (clock.textContent = String(Date.now())), 250);
</script>`,
      );
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      resume(Effect.succeed({ url: `http://127.0.0.1:${port}/`, typed: () => typed, server }));
    });
  }),
  ({ server }) => Effect.callback<void>((resume) => void server.close(() => resume(Effect.void))),
);

/** The sessions labelled "J3 Bots" the engine CLI lists for the data directory `home`. */
const j3Sessions = Effect.fnUntraced(function* (executable: string, home: string) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const listed = yield* Effect.scoped(
    Effect.gen(function* () {
      const handle = yield* spawner.spawn(
        ChildProcess.make(executable, ["auth", "session", "list", "--base-dir", home, "--json"]),
      );
      return yield* handle.stdout.pipe(Stream.decodeText(), Stream.mkString);
    }),
  );
  const sessions = yield* Schema.decodeEffect(
    Schema.fromJsonString(
      Schema.Array(
        Schema.Struct({
          sessionId: Schema.String,
          client: Schema.optionalKey(Schema.Struct({ label: Schema.optionalKey(Schema.String) })),
        }),
      ),
    ),
  )(listed);
  return sessions.filter((session) => session.client?.label === "J3 Bots");
});

describe("Engine conformance, real engine only", () => {
  it.live(
    "revokes the token an earlier J3 Bots minted once it mints one with the browser scope",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const { home: benchHome } = yield* paths;
        const files = yield* makePrivateFiles(() => Effect.succeed(true));
        const executable = yield* ensureInstalled({
          home: benchHome,
          platform: NodeProcess.platform,
          arch: NodeProcess.arch,
          sha256: pin.sha256,
          files,
        });
        // A data directory of its own, with no engine running on it.
        const home = yield* fs.makeTempDirectoryScoped();
        yield* ensureCredential({ executable, home, files });
        const first = yield* j3Sessions(executable, home);
        assert.strictEqual(first.length, 1);

        // As J3 Bots before 0.4 left it: no scopes recorded, so it lacks `preview:operate`.
        const stored = path.join(engineFolders(path, home).j3, "credential.json");
        const Unscoped = Schema.fromJsonString(
          Schema.Struct({ token: Schema.String, expiresAt: Schema.String }),
        );
        const unscoped = yield* Schema.decodeEffect(Unscoped)(yield* fs.readFileString(stored));
        yield* files.write(stored, yield* Schema.encodeEffect(Unscoped)(unscoped));
        yield* ensureCredential({ executable, home, files });

        const after = yield* j3Sessions(executable, home);
        assert.strictEqual(after.length, 1);
        assert.notStrictEqual(after[0]?.sessionId, first[0]?.sessionId);
      }).pipe(Effect.scoped, Effect.provide([platform, SecureRandom.layerWebCrypto])),
    { timeout: 120_000 },
  );

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
    "lets a session use the browser from its next turn once its project allows it, and stops it again",
    () =>
      Effect.gen(function* () {
        const engine = yield* Engine;
        const bench = yield* Bench;
        const { sessionId, projectId, queue } = yield* openWatched("browser");
        /** Whether the engine took the session's call to one of its browser tools. */
        const browser = Effect.fnUntraced(function* (name: string) {
          const probe = yield* engine.dispatch({
            key: bench.key(`browser-${name}`),
            sessionId,
            text: "[[script:browser]]",
            attachments: [],
            delivery: { _tag: "start", freshContext: false },
          });
          const speech = yield* until(
            queue,
            "host-speech",
            (event) => event.turnId === turnOf(probe),
          );
          yield* until(queue, "turn-finished", (event) => event.turnId === turnOf(probe));
          return speech.text;
        });
        const allow = (enabled: boolean) =>
          engine
            .setBrowserAccess({ projectId, enabled })
            .pipe(Effect.andThen(engine.configureSession({ sessionId, reloadTools: true })));

        // The suite's cases share a project, which an earlier run may have left allowed.
        yield* engine.setBrowserAccess({ projectId, enabled: false });
        const before = yield* browser("off");
        yield* allow(true);
        const allowed = yield* browser("on");
        yield* allow(false);
        const after = yield* browser("off-again");

        assert.deepStrictEqual([before, allowed, after], ["refused", "allowed", "refused"]);
      }).pipe(
        Effect.provide(bench.pipe(Layer.provideMerge(realEngine), Layer.provideMerge(platform))),
      ),
    { timeout: 180_000 },
  );

  it.live(
    "refuses the browser to a delegated child that a send runs again once it is withdrawn",
    () =>
      Effect.gen(function* () {
        const engine = yield* Engine;
        const bench = yield* Bench;
        const rpc = yield* foreignRpc;
        const { sessionId, projectId, queue } = yield* openWatched("browser-child");
        yield* engine.setBrowserAccess({ projectId, enabled: true });
        const delegating = yield* engine.dispatch({
          key: bench.key("browser-child-delegate"),
          sessionId,
          text: "[[script:delegate child=browser]]",
          attachments: [],
          delivery: { _tag: "start", freshContext: false },
        });
        yield* until(queue, "turn-finished", (event) => event.turnId === turnOf(delegating));
        const { threads } = yield* rpc["orchestration.getThreadFamily"]({
          threadId: ThreadId.make(sessionId),
        });
        const child = threads.find((thread) => thread.id !== ThreadId.make(sessionId));
        assert.isDefined(child);
        const childSpeech = speechReader(
          yield* engine
            .events({ sessionId: SessionId.make(child.id), after: null })
            .pipe(Stream.orDie, Stream.toQueue({ capacity: "unbounded" })),
        );
        const first = yield* childSpeech(1);
        // The engine wakes the parent once the child's task ended.
        yield* until(queue, "turn-finished", (event) => event.turnId !== turnOf(delegating));

        yield* engine.withdrawBrowserAccess(projectId);
        const sending = yield* engine.dispatch({
          key: bench.key("browser-child-send"),
          sessionId,
          text: `[[script:send to=${child.id}]]`,
          attachments: [],
          delivery: { _tag: "start", freshContext: false },
        });
        yield* until(queue, "turn-finished", (event) => event.turnId === turnOf(sending));
        const second = yield* childSpeech(1);

        assert.deepStrictEqual([...first, ...second], ["allowed", "refused"]);
      }).pipe(
        Effect.provide(bench.pipe(Layer.provideMerge(realEngine), Layer.provideMerge(platform))),
      ),
    { timeout: 180_000 },
  );

  it.live(
    "takes the browser from a turn the engine queued behind a running one when it is withdrawn",
    () =>
      Effect.gen(function* () {
        const engine = yield* Engine;
        const bench = yield* Bench;
        const rpc = yield* foreignRpc;
        const { sessionId, projectId, queue } = yield* openWatched("browser-queued");
        yield* engine.setBrowserAccess({ projectId, enabled: true });
        const running = yield* engine.dispatch({
          key: bench.key("browser-queued-running"),
          sessionId,
          text: "[[script:slow every=500 for=120000]]",
          attachments: [],
          delivery: { _tag: "start", freshContext: false },
        });
        yield* until(queue, "turn-started", (event) => event.turnId === turnOf(running));
        // A turn queued behind it, as the engine queues one of its own, here
        // from another of its clients.
        const queuedId = bench.key("browser-queued-successor");
        yield* rpc["orchestration.dispatchCommand"]({
          type: "message.dispatch",
          commandId: CommandId.make(queuedId),
          threadId: ThreadId.make(sessionId),
          messageId: MessageId.make(queuedId),
          text: "[[script:browser]]",
          attachments: [],
          dispatchMode: { type: "queue_after_active" },
          createdBy: "user",
          creationSource: "web",
        });

        yield* engine.withdrawBrowserAccess(projectId);
        // The withdrawal's stop holds the queue; released as the server does.
        const held = yield* until(queue, "queue-held");
        yield* engine.resumeQueue({ sessionId, hold: held.cursor });
        const speech = yield* until(queue, "host-speech");

        assert.strictEqual(speech.text, "refused");
      }).pipe(
        Effect.provide(bench.pipe(Layer.provideMerge(realEngine), Layer.provideMerge(platform))),
      ),
    { timeout: 180_000 },
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
    "refuses an opening again under the key it refused",
    () =>
      Effect.gen(function* () {
        const engine = yield* Engine;
        const bench = yield* Bench;
        const projectId = yield* engine.ensureProject({
          workspacePath: bench.workspacePath,
          title: "refused-opening",
        });
        const key = bench.key("session-refused-opening");
        // Another client takes the thread the key names: the engine refuses
        // the opening, and keeps that refusal for the key.
        const rpc = yield* foreignRpc;
        yield* rpc["orchestration.dispatchCommand"]({
          type: "thread.create",
          commandId: CommandId.make(bench.key("refused-opening-taken")),
          threadId: ThreadId.make(threadIdFor(key)),
          projectId: ProjectId.make(projectId),
          title: "Taken",
          modelSelection: {
            instanceId: ProviderInstanceId.make(instanceIdFor(PROVIDER)),
            model: bench.model.modelId,
          },
          runtimeMode: "approval-required",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdBy: "user",
          creationSource: "web",
        }).pipe(Effect.orDie);
        const open = engine
          .openSession({
            key,
            projectId,
            title: "refused-opening",
            model: bench.model,
            permissionMode: "supervised",
          })
          .pipe(Effect.flip);

        const first = yield* open;
        const again = yield* open;

        assert.strictEqual(first._tag, "OpenRejected");
        assert.strictEqual(again._tag, "OpenRejected");
      }).pipe(
        Effect.provide(bench.pipe(Layer.provideMerge(realEngine), Layer.provideMerge(platform))),
      ),
    { timeout: 120_000 },
  );

  it.live.runIf(SUPERVISED_ONLY)(
    "refuses a permission mode above the policy's ceiling, naming it and keeping nothing for the key",
    () =>
      Effect.gen(function* () {
        const engine = yield* Engine;
        const bench = yield* Bench;
        const projectId = yield* engine.ensureProject({
          workspacePath: bench.workspacePath,
          title: "mode-ceiling",
        });
        const key = bench.key("session-mode-ceiling");
        const open = (permissionMode: "supervised" | "full-access") =>
          engine.openSession({
            key,
            projectId,
            title: "mode-ceiling",
            model: bench.model,
            permissionMode,
          });

        const above = yield* open("full-access").pipe(Effect.flip);
        // Opened under the same key in a mode the policy allows: the refusal
        // left no receipt to replay.
        const sessionId = yield* open("supervised");
        const raised = yield* engine
          .configureSession({ sessionId, permissionMode: "full-access" })
          .pipe(Effect.flip);

        // Each refusal names the policy's ceiling, read from the engine's config.
        assert.deepStrictEqual(
          [above, raised].map((error) =>
            error._tag === "PermissionModeRefused" ? error.allowed : error._tag,
          ),
          ["supervised", "supervised"],
        );
      }).pipe(
        Effect.provide(bench.pipe(Layer.provideMerge(realEngine), Layer.provideMerge(platform))),
      ),
    { timeout: 120_000 },
  );

  it.live.runIf(SUPERVISED_ONLY)(
    "refuses a turn in a thread already above the policy's ceiling, naming both modes and keeping nothing for the key",
    () =>
      Effect.gen(function* () {
        const engine = yield* Engine;
        const bench = yield* Bench;
        const fs = yield* FileSystem.FileSystem;
        const { home } = yield* paths;
        const policyFile = yield* POLICY_FILE;
        const policy = yield* fs.readFileString(policyFile).pipe(Effect.orDie);
        const sessionId = yield* Effect.gen(function* () {
          // Opened in Full access while the engine runs under no policy.
          yield* fs.remove(policyFile).pipe(Effect.orDie);
          yield* restartEngine(home);
          const projectId = yield* onceReachable(
            engine.ensureProject({ workspacePath: bench.workspacePath, title: "turn-ceiling" }),
          );
          return yield* onceReachable(
            engine.openSession({
              key: bench.key("session-turn-ceiling"),
              projectId,
              title: "turn-ceiling",
              model: bench.model,
              permissionMode: "full-access",
            }),
          );
        }).pipe(Effect.ensuring(fs.writeFileString(policyFile, policy).pipe(Effect.orDie)));
        // The policy is installed, and the engine starts again under it.
        yield* restartEngine(home);
        const input = {
          key: bench.key("turn-ceiling"),
          sessionId,
          text: directive({ _tag: "reply" }),
          attachments: [],
          delivery: { _tag: "start", freshContext: false },
        } as const;

        const first = yield* refusedWith(onceReachable(engine.dispatch(input)), "a first send");
        const again = yield* refusedWith(engine.redispatch(input), "a recovery");
        // Lowered to the ceiling, which the policy lets a thread above it do,
        // the session takes the same key: the refusals left no receipt.
        yield* engine.configureSession({ sessionId, permissionMode: "supervised" });
        yield* engine.redispatch(input);

        assert.deepStrictEqual(
          [first, again].map((error) =>
            error._tag === "PermissionModeRefused"
              ? [error.permissionMode, error.allowed]
              : error._tag,
          ),
          [
            ["full-access", "supervised"],
            ["full-access", "supervised"],
          ],
        );
      }).pipe(
        Effect.scoped,
        Effect.provide(bench.pipe(Layer.provideMerge(realEngine), Layer.provideMerge(platform))),
      ),
    { timeout: 180_000 },
  );

  it.live(
    "retires a session whose archive it refused while a delegated task ran, once the task is gone",
    () =>
      Effect.gen(function* () {
        const engine = yield* Engine;
        const bench = yield* Bench;
        const { sessionId, queue } = yield* openWatched("retire-delegated");
        const delegating = yield* engine.dispatch({
          key: bench.key("retire-delegated"),
          sessionId,
          text: "[[script:delegate child=slow]]",
          attachments: [],
          delivery: { _tag: "start", freshContext: false },
        });
        yield* until(queue, "turn-finished", (event) => event.turnId === turnOf(delegating));
        const retire = engine.retireSession(sessionId).pipe(
          Effect.as(true),
          Effect.catchTag("RetireRejected", () => Effect.succeed(false)),
          Effect.orDie,
        );

        // The retirement's Stop only queues the delegated task's end, and the
        // engine refuses an archive while the task runs. Each retirement
        // sends keys of its own, so a later one is not refused for good.
        const first = yield* retire;
        let retired = first;
        let round = 0;
        for (; !retired && round < 150; round++) {
          yield* Effect.sleep("1 second");
          retired = yield* retire;
        }
        yield* Effect.log(`Retired after ${round} more rounds`);
        // A thread that is gone counts as retired too: read that it is archived.
        const rpc = yield* foreignRpc;
        const { thread } = yield* rpc["orchestration.getThreadProjection"]({
          threadId: ThreadId.make(sessionId),
        });

        assert.isFalse(first);
        assert.isTrue(retired);
        assert.isNotNull(thread.archivedAt);
        assert.isNull(thread.deletedAt);
      }).pipe(
        Effect.provide(bench.pipe(Layer.provideMerge(realEngine), Layer.provideMerge(platform))),
      ),
    { timeout: 240_000 },
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

  it.live(
    "streams a bot's tab to a viewer, which takes it from the agent, uses it and gives it back",
    () =>
      Effect.gen(function* () {
        const engine = yield* Engine;
        const bench = yield* Bench;
        const browser = yield* BrowserBridge;
        const page = yield* testPage;
        const { sessionId, queue } = yield* openWatched("browser");
        const tabs = yield* browser
          .tabs(Effect.succeed([sessionId]))
          .pipe(Stream.toQueue({ capacity: "unbounded" }));
        const browsing = yield* engine.dispatch({
          key: bench.key("browse"),
          sessionId,
          text: `[[script:browse url=${page.url} every=1000 for=120000]]`,
          attachments: [],
          delivery: { _tag: "start", freshContext: false },
        });

        // The agent says why when it cannot open the page.
        const failed = until(queue, "host-speech", (event) =>
          event.text.startsWith("Browser failed"),
        ).pipe(Effect.flatMap((event) => Effect.die(new Error(event.text))));
        const shown = Effect.gen(function* () {
          let found = yield* Queue.take(tabs);
          while (!found.some((tab) => tab.sessionId === sessionId && tab.url === page.url)) {
            found = yield* Queue.take(tabs);
          }
          return found;
        });
        const listed = yield* Effect.raceFirst(shown, failed);
        const tab = listed.find((tab) => tab.sessionId === sessionId);
        assert.isDefined(tab);
        if (tab === undefined) return;

        const viewer = yield* browser.openViewer({
          tab: tab.id,
          maxWidth: 800,
          maxHeight: 600,
          quality: 60,
        });
        const outputs = yield* viewer.output.pipe(
          Stream.orDie,
          Stream.toQueue({ capacity: "unbounded" }),
        );
        let pictures = 0;
        /** Takes outputs, drawing each picture, until one matches. */
        const next = Effect.fnUntraced(function* (match: (output: ViewerOutput) => boolean) {
          while (true) {
            const output = yield* Queue.take(outputs).pipe(Effect.orDie);
            if (output._tag === "frame") {
              assert.deepStrictEqual([...output.jpeg.subarray(0, 2)], [0xff, 0xd8]);
              pictures++;
              yield* viewer.ack;
            }
            if (match(output)) return output;
          }
        });
        const controlledBy = (controller: string) => (output: ViewerOutput) =>
          output._tag === "control" && output.controller === controller;

        yield* next(controlledBy("bot"));
        yield* next((output) => output._tag === "frame");
        yield* viewer.send({ type: "take" });
        yield* next(controlledBy("this-viewer"));
        const refused = yield* until(queue, "host-speech", (event) =>
          event.text.startsWith("Browser refused"),
        );

        const click = { x: 100, y: 50, buttons: 1, clickCount: 1, modifiers: 0 } as const;
        yield* viewer.send({ type: "pointer", action: "down", button: "left", ...click });
        yield* viewer.send({ type: "pointer", action: "up", button: "left", ...click, buttons: 0 });
        yield* viewer.send({ type: "text", text: "typed by a viewer" });
        for (let tries = 0; page.typed() !== "typed by a viewer" && tries < 100; tries++) {
          yield* Effect.sleep("100 millis");
        }
        const typed = page.typed();

        yield* viewer.send({ type: "release" });
        yield* next(controlledBy("bot"));
        const resumed = yield* until(queue, "host-speech", (event) =>
          event.text.startsWith("Browser acted again"),
        );
        yield* until(queue, "turn-finished", (event) => event.turnId === turnOf(browsing));

        assert.isAbove(pictures, 0);
        assert.include(refused.text, "A human controls this browser tab");
        assert.strictEqual(typed, "typed by a viewer");
        assert.strictEqual(resumed.text, "Browser acted again.");
      }).pipe(
        Effect.scoped,
        Effect.provide(bench.pipe(Layer.provideMerge(realEngine), Layer.provideMerge(platform))),
      ),
    { timeout: 180_000 },
  );
});
