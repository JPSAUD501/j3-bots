# Engine

J3 Bots runs a stock T3 Code server and drives it as a headless client. This document covers how the engine is installed, isolated, connected to, configured and upgraded, and which of its behaviors J3 Bots has to design around.

Labels **Verified**, **Read** and **Assumed** are defined in the [documentation index](../README.md). Sources for every claim are in [research/t3-code.md](../research/t3-code.md).

## Isolation

The engine is a separate T3 Code instance that belongs to J3 Bots. It shares nothing with a T3 Code the operator may already use for coding.

- **Own data directory.** The engine runs with `--base-dir <J3_HOME>/engine`. A fresh directory gets its own database, settings, secrets and environment identity. **Verified**: an instance started this way came up with a different environment id and no projects or threads from the main instance.
- **Loopback only.** `--host 127.0.0.1` and an explicit `--port`. Without an explicit port, a second instance picks any free one. **Read**.
- **Supervised by J3 Bots.** The J3 Bots server starts the engine as a child process (`t3 serve --no-browser`) and restarts it if it exits. T3 Code's own service installer allows one service per user and refuses a second data directory, so J3 Bots cannot use it. **Read**.
- **Provider processes are not the engine's children.** On Linux the engine launches each provider CLI through `systemd-run --user --scope`, so a process tree under the engine's pid misses them. Stopping the engine stops them all. Memory accounting and leak checks go by the engine's systemd slice, not by parent pid. **Verified**.
- **Not inside a Git checkout.** `J3_HOME` must not sit under a repository: T3 Code treats any folder inside one as part of it, which would turn on checkpointing for bot workspaces. **Read**.

What is still shared with the machine:

- **Provider homes.** By default Claude Code uses `~/.claude` and Codex uses `~/.codex`. J3 Bots gives each engine provider instance its own home directory, so bots do not inherit the operator's coding instructions, hooks, skills or MCP servers. See [open question 2](../open-questions.md).
- **Managed policy.** `/etc/t3code/policy.json` on Linux applies to every T3 Code instance on the machine, including the engine. **Read**.

## Version pinning

J3 Bots names one exact T3 Code version, in `engine.json` at the repository root: the release version and the commit its tag points at. The pin is `0.1.11-nightly.20261120.4969`, commit `db51b6719f116de156401ed264b5d732f35b2c93`. **Verified**: the tag `v0.1.11-nightly.20261120.4969` points at that commit.

It is the oldest release on which the engine gives a stdio MCP server that Codex starts the `T3CODE_THREAD_ID` variable, which the [bot tool bridge](server.md#bot-tools) needs to identify a Codex bot. Upstream pull request 39414 added it. **Verified**: absent on `4941`, present on `4969`.

The source claims labelled **Read** were made at commit `9bb92a4`, unless the research notes name `db51b67`. `db51b67` is `9bb92a4` plus ten commits, so every Read claim is at or before the pin. Each one still holds only until it is checked at the pin, by the adapter's code or its conformance suite. A release's commit is in its title on GitHub, and it is often older than `main` on the same day: a fact read in source counts for a release only if that commit contains it.

The engine binary is the standalone release archive for the platform, downloaded once, checked against the release's `SHA256SUMS`, and stored under `<J3_HOME>/engine/runtime/<version>/`.

At startup the adapter reads the engine's public descriptor and refuses to continue if the server version or the orchestration protocol version is not the pinned one. **Verified**: `GET /.well-known/t3/environment` returns `serverVersion` and `orchestrationProtocolVersion` without authentication.

### The engine's contracts

The adapter decodes the protocol with T3 Code's own schemas ([decision 0007](../decisions/0007-client-and-server-stack.md)). Their package, `@t3tools/contracts`, is not published to a registry, so J3 Bots vendors it.

- `packages/engine-t3/vendor/t3-contracts/` holds the package's source at the pinned commit, unmodified, with T3 Code's MIT license. It is a workspace package under its upstream name. Only `packages/engine-t3` may import it: a lint rule refuses an `@t3tools/*` import anywhere else.
- `pnpm vendor:t3-contracts` regenerates it from `engine.json`. The script refuses to run if the release tag no longer points at the pinned commit, and leaves out upstream's tests. A weekly CI job re-runs it and fails if the result differs from what is committed.
- The package depends only on `effect`. J3 Bots' version catalog pins exactly the Effect versions T3 Code pins at the commit (`effect` 4.1.3, `@effect/platform-node` 4.1.2, unchanged from `4941`; **Read** in `pnpm-workspace.yaml` at `db51b67`), so the vendored schemas and J3 Bots' code share one copy of Effect. **Verified**: the vendored source typechecks in J3 Bots' build with T3 Code's compiler settings.

## Connecting

The engine exposes two interfaces. J3 Bots uses the one T3 Code's own clients use.

| Interface | What it is | J3 Bots' use |
| --- | --- | --- |
| `/ws` | Effect RPC over WebSocket, JSON frames. Commands, queries and live subscriptions. | Everything |
| `/mcp` | MCP over HTTP with OAuth. Request and response only; no push. | Not used by J3 Bots. Bots use it from inside their sessions, as T3 Code intends. |

The connection sequence:

1. **Mint a token.** `t3 auth session issue --base-dir <engine dir> --scope orchestration:read --scope orchestration:operate --token-only`, run with the pinned binary. This works without a sign-in because the CLI opens the engine's database directly. The token lasts 30 days and does not renew, so the server mints a new one at every start and before expiry. **Verified** (minting), **Read** (lifetime).
2. **Open the socket.** `ws://127.0.0.1:<port>/ws?orchestrationProtocol=2`, authenticated either with an `Authorization: Bearer` header on the upgrade or with a five-minute ticket from `POST /api/auth/websocket-ticket/rpc` passed as `&wsTicket=`. **Verified**, both, from a plain Node process with no T3 Code dependency.
3. **Subscribe.** `orchestration.subscribeShell` streams every thread's status, pending requests and last message. `orchestration.subscribeThread` with `{threadId, afterSequence?}` streams one thread: a `snapshot` item when no `afterSequence` is given, then `event` items. **Verified**.

A whole turn has been driven this way from outside: create a project and a thread, dispatch, stream, answer an approval, answer a question, interrupt, and resume after a dropped socket and after an engine restart. **Verified** on Claude Code and Codex. The command and event shapes the adapter needs are in [research/t3-code.md](../research/t3-code.md#the-turn-protocol).

Protocol facts the adapter depends on:

- Each WebSocket message is one JSON object: `Request`, `Ack`, `Interrupt`, `Ping` from the client; `Chunk`, `Exit`, `Defect`, `Pong` from the server. **Verified** for all but `Defect`.
- **Every stream chunk must be acknowledged.** A subscription whose chunks are not acked stops after a few chunks and continues once they are. **Verified**; the window of eight is **Read**.
- **Events replace whole entities.** A streaming assistant message arrives as its full text so far. The client upserts by id and never applies deltas. **Verified**.
- **Resume by sequence.** The client remembers the last sequence it applied and resubscribes with `afterSequence`. The stream continues from the next event, with nothing lost, across a dropped socket and across an engine restart. If that point was pruned, the server sends a fresh snapshot (**Read**). Events may overlap; the client drops anything at or below what it has. **Verified**.
- **Sequences belong to the environment, not the thread.** One counter serves every thread and project, so a thread's stream has gaps. A gap is not loss. **Verified**.
- **Commands are idempotent by `commandId`.** A replayed `message.dispatch` returns the first one's sequence and starts no second run, even with a different message id. **Verified**. The engine reserves the command's receipt in the same transaction that commits its events, compares only the id, never the payload, and keeps receipts for good; only its events are pruned, after a day (**Read** at `db51b67`, `EventSink.ts`, `CommandReceiptStore.ts`, `ProjectionMaintenance.ts`). A command it refused leaves a rejected receipt, and a replay of that id fails as previously rejected; a replay of an accepted id answers `{sequence}` and applies nothing (**Read**, `Orchestrator.ts`, `replayCommandReceipt`). Two refusals leave no receipt: a managed-policy limit and a mode ceiling. The adapter derives every command id, and a dispatch's message id, from a key the server stored before the call, so a retry after a crash cannot start a second turn.
- **An error reply does not prove nothing was applied.** Steps that run after the commit can fail and turn an applied command's reply into an error (**Read**, `dispatchWithReceiptEffect`). While the engine starts, commands wait in a queue of its own and can be applied after the client gave up on them (**Read**, `serverRuntimeStartup.ts`, `makeCommandGate`). So the adapter answers a dispatch's error by sending the same command id once more: a previously-rejected reply is `DispatchRejected`, an accepted one means it was applied, a policy refusal that keeps no receipt is `DispatchRejected` (the server never reuses the key), and anything else is `EngineIndeterminate`.
- **A subscription can mark where it caught up.** `subscribeThread` with `requestCompletionMarker: true` sends a `synchronized` item after the replay (or the snapshot) and before live events, so everything the engine had recorded for the thread when the subscription opened has arrived. **Read** at `db51b67`, `apps/server/src/ws.ts`. The adapter's `synchronize` is built on it.
- **Revoking the session closes the socket.** The adapter must reconnect and resume at any time. **Read**.

A token with `orchestration:operate` can start a full-access agent. It is equivalent to a shell as the server's user and is handled as such.

## The adapter's interface

The rest of J3 Bots sees the engine only through the `Engine` service exported by `packages/engine-t3`. It speaks of sessions, turns and requests; nothing in it names a T3 Code type, and nothing outside the package imports one. The TSDoc in `Engine.ts` and `events.ts` is the precise contract; this section is its outline.

- **Durable keys.** Every call that changes engine state (open a session, dispatch, stop, answer a request) takes a key the server has already stored. The adapter derives the engine's command id from it and, for a dispatch, the message id. A retry with the same key is the same command.
- **Three ways to fail, and refusals.** `EngineUnavailable` and `EngineIncompatible` mean the command was not sent. `EngineIndeterminate` means it was sent and the reply was lost: it may have been applied, and it is never read as "not applied". `DispatchRejected` means the engine refused a dispatch: nothing was applied and the key is spent. A refused `respond` is `RequestClosed`; a refused `stop` step (the turn had already ended) counts as done.
- **A lost reply is resolved by sending again.** There is no lookup: the server sends the same key with the same input until it gets a definite answer, which is the answer for the key. A repeat of an applied key answers `applied-earlier`, because the engine does not say how the first was accepted; delivery still comes from the events. Staged files must still be usable, since the engine claims them before it checks the receipt (**Read** at `db51b67`, `ThreadMessageIntake.dispatchCommand`); a file staged again for a repeat is left unused.
- **Delivery is start or steer.** `start` runs a message as a new turn. The adapter refuses it with `SessionBusy`, sending nothing, when it already sees a turn running or waiting in the session, but that check is best effort: a turn the engine starts itself can begin between the check and the engine applying the start, and the engine then queues the start behind it. `steer` adds a message to one named running turn. The adapter never asks for `queue_after_active`; waiting and priority belong to the server ([Server: the wake pipeline](server.md#the-wake-pipeline)).
- **A disposition is acceptance, not delivery.** `dispatch` answers `started`, `queued`, `steered` or `new-turn`, each with the engine turn, or `applied-earlier`. A dispatch is delivered when `turn-started` arrives with the cause `dispatch` and its key, or, for `steered`, when its steer settles as taken.
- **A steer settles when its turn ends.** Whether a steer was taken is known only once the run it steered has settled (**Read** at `db51b67`, `requeueUnreadSteers` runs as a reaction to the settled run). So the adapter reports nothing about a steer until that turn's `turn-finished`, and then exactly one of: `steered` (taken), `steer-dropped` (Stop ended the turn first; the engine shows its own notice) or `steer-requeued` (the turn ended any other way without taking it, and the engine queued it as a follow-up turn caused by the same dispatch). The same rule covers a steer the engine could not apply at once: one sent before the target's provider turn started, which the engine keeps aside and steers in when it starts, or runs as the follow-up if the target ends first; and one to a provider that steers only by interrupting the turn and restarting it with the message, which stays one J3 Bots turn across its attempts and keeps the cause of its first attempt.
- **Events resume by replay or by replacement, never both.** `events(session, after)` replays every event after the cursor while the engine still has them. When it no longer does, the stream starts with one `replaced` event carrying a new cursor and everything reconciliation needs: the open turns with their steps, the open requests, the turns that ended with their outcome and final steps, the host speech, the request resolutions and how each steer settled. The engine keeps no sequence for a turn's end, so a replacement may repeat turns, speech and resolutions the server already applied; the server reconciles by stable ids, and applying one again changes nothing. Live events follow. The server applies each event and stores its cursor in one transaction. A cursor of `null` is only for a session that was never dispatched to.
- **Synchronization.** `synchronize(session, token)` puts a `synchronized` event with the token on the session's streams after every event the engine had when it was called.
- **Tool calls.** Every call the bot makes to a `j3` tool arrives as `tool-call` with its turn, the engine's id for the call, the bare tool name and a digest of its input (`toolInputDigest`, SHA-256 of the input as canonical JSON), `open` when the bot calls it and `closed` when it returns; a turn's end closes the rest. The engine records the call apart from the request the bridge receives, so the event can come after the request. The bridge matches a request to its call with these ([Server: bot tools](server.md#bot-tools)).
- **Continuations.** A turn that failed at a usage limit, and that the engine will resume at the reset, ends with `continuation: {resumesAt}` on its `turn-finished`. The resumed turn's cause is `continuation` with the turn it directly continues; `continuation-dropped` says one will not run. The adapter applies the engine's own rule to decide this at the turn's end, since the engine arms the resume asynchronously. Restart continuations are turned off ([Provisioning](#provisioning)).
- **Host speech.** A call to the engine's `send_to_user` tool arrives as `host-speech` with its turn, its text and a stable id, so the server can deliver it once instead of losing it.
- **Requests.** Approvals and questions are answered with `respond`. Secret requests are answered with `respondSecret`, which carries the value as a redacted string to the engine's own secret path; the value never enters an event, a log or a stored record. A request closes as `answered`, `provided`, `declined` or `expired`, and every request open on a turn expires when the turn ends. `respondSecret` has no key, and only its success proves that its own answer was the one taken: a retry after a lost reply that finds the request closed learns only how it closed, which may be another answer or `expired`.
- **Stop.** `stop` ends the session's running turn and the delegated work the engine can reach, cancels every turn waiting in the engine's queue, and drops untaken steers. It is several engine commands, `thread.stop` and then a `queued-run.cancel` per waiting run, and a message that reaches the session between them can release the hold and start a turn the cancels miss. So the server sends a session no dispatch while a Stop of it is unsettled ([Server: Stop](server.md#stop)). It is the operator's Stop, also used when a room is archived; a rotation retires the old session with `retireSession`, which stops it the same way.
- **Held queues.** The engine holds a session's queue after an engine restart, a provider error, a model or provider change while the replaced provider session still runs background work, and a Stop. The adapter resumes every held queue of a session whose events it streams, once per hold: if the engine holds it again in answer, it stays held until the engine's next change of hold, so the two never loop. It never resumes a hold a Stop made, nor any hold in a session while a `stop` of it has not returned. The server never resumes a queue.
- **Attachments.** `stageAttachment` uploads a file and returns the id the engine minted, with how long it stays usable; the server stores it with the dispatch before dispatching. `normalizeAttachmentMetadata` puts a file's name and media type in the form the engine's upload takes, and the server applies it at upload. `attachmentLimitViolation` checks a dispatch's files against the engine's limits, so a dispatch the engine would refuse is never written.
- **Session ids.** A session's id is the engine thread id. The bot tool bridge receives the same id as its caller identity, and `sessionOfToolCaller(environment)` decodes it, so the server never names the engine's variable.

`@j3-bots/engine-t3/testing` provides an in-memory engine that honors these rules, with controls to drive the engine's side and tests for the ones a caller relies on: a key applied once and a repeat answered `applied-earlier`, a lost reply resolved by sending again, a rejected key refused on every repeat, a refused start that sends nothing, a start queued behind a turn the engine began while it was on its way, a steer that settles after its turn ends (taken, requeued, or dropped by Stop), a steer held for a turn that has not started, a late steer that becomes a new turn, Stop as its engine steps with a message slipping in between, a held queue resumed once and left held when the engine holds it again, a turn that failed before it started told apart from one that ran unseen, tool calls closed with their turn and recorded late, a usage-limit continuation that runs or drops, replay, a replacement that repeats turns already seen end and carries host speech and resolutions, a synchronization marker, requests that expire with their turn, a secret handed over once, and nothing applied while the engine is unreachable. Server tests run against it. Only the conformance suite runs a real engine.

## What J3 Bots uses, and what it leaves alone

J3 Bots keeps the engine surface it touches small, because every part it touches is a part an upgrade can break.

| Engine capability | Used | How |
| --- | --- | --- |
| Projects | Yes | One project per bot, on the bot's workspace folder. A folder belongs to at most one project: `project.create` on a folder that has one fails with a conflict, so J3 Bots stores the project id and never re-creates it (**Verified**) |
| Threads | Yes | The bot's main session and its side sessions |
| `message.dispatch` with `start_immediately` and `steer_active` | Yes | Every wake. Never `queue_after_active`: the server holds waiting wakes itself. A `start_immediately` that meets an active run is still queued by the engine |
| `queue.resume` | Yes | The adapter resumes a held queue once per hold, after an engine restart, a provider error or a provider switch; never a Stop's hold, and never while a Stop is unsettled |
| `thread.stop` and `queued-run.cancel` | Yes | The operator's Stop: the first ends the running turn and holds the queue, the second cancels each held turn. A refusal of either as moot counts as done |
| `run.interrupt` | No | Stop covers it, and an interrupt can drop a delegated task's delivery |
| Runtime requests (approvals, questions) | Yes | Shown as cards; answered with `runtime-request.respond` |
| Secret requests | Yes | A bot's `request_secret` call is shown as a card; the operator's value goes to `secrets.answerRequest` and nowhere else |
| Model selection and runtime mode per thread | Yes | Per-bot model and permission mode |
| Attachment upload | Yes | Files the operator sends with a message, staged before the dispatch with the id the engine mints |
| Provider status and usage limits | Yes | Engine health, usage view, blocked state |
| Fresh context on a dispatch | Yes | Fresh start, session rotation |
| Scheduled tasks and webhooks | No | J3 Bots schedules its own wakes. See [decision 0005](../decisions/0005-j3-bots-owns-wakes.md) |
| Thread-to-thread messaging tools | No | Bots message each other through J3 Bots |
| Worktrees, checkpoints, diffs, pull requests | No | Coding features |
| T3 Connect, pairing, guest links | No | J3 Bots has its own client access |
| Settlement, snooze, pinning | No | Sidebar features of T3 Code's clients; auto-settle is turned off |

## Provisioning

Before first start, J3 Bots writes `<engine dir>/userdata/settings.json`. The engine reads it at startup and watches it afterwards: a changed provider instance applies to sessions started after the change, with no restart. **Verified**.

| Setting | Value | Why |
| --- | --- | --- |
| `sidebarAutoSettleAfterDays` | `null` | A bot's session must not be settled after a week of quiet. A settled thread loses usage-limit auto-resume. |
| `continueThreadsAfterServerUpdate` | `false` | Off, the engine arms no continuation message when it restarts (**Read** at `db51b67`, `ProviderRuntimeRecoveryService.prepareForShutdown`, `RestartContinuation.ts`). Whether one is pending is visible only over `/mcp`, so J3 Bots could not keep a dispatch open for it; a turn the restart cut short ends `interrupted` and the server handles it like any other. |
| `sidebarAutoSettleOnMerge` | `false` | Not applicable. |
| `idleCompaction` (Claude) | `beforeCacheExpires` | An unattended bot has nobody to press a compact button. |
| `autoResumeLimitedThreads` | `true` | A bot that hit a limit should continue at the reset. |
| `enableAgentDeviceAccess` | `false` | Bots do not drive phone simulators, and turning this off removes T3 Code's device instructions from every session. |
| `providerInstances` | Generated | One instance per provider the operator enabled, each with its own home, launch arguments and environment. |

An environment variable marked `sensitive` is not stored in `settings.json`. The entry carries `"value": "", "sensitive": true, "valueRedacted": true`, and the value lives in the engine's secret store, one file per variable named after the instance id and the variable name. **Verified**: an instance provisioned this way authenticated against its provider.

Provider instances are where J3 Bots attaches its prompt and its tools. Every item below is **Verified** on release `4969` unless marked.

For Claude Code:

- `homePath` points at a J3-owned config directory, which the engine passes as `CLAUDE_CONFIG_DIR`.
- That directory's `.claude.json` holds `hasCompletedOnboarding: true` and the `j3` MCP server under `mcpServers` (stdio: `command`, `args`, `env`). Claude Code rewrites this file with its own state, so J3 Bots merges its keys into it and never replaces it.
- That directory's `settings.json` is applied to every session. It is where auto-memory is turned off; the setting's key is **Assumed**.
- `launchArgs` is `--append-system-prompt-file .j3/system.md --allowedTools mcp__j3__* --disallowedTools <tools>`:
  - The prompt file path is resolved inside each thread's project folder, so one instance serves every bot and each gets its own file.
  - `--allowedTools mcp__j3__*` lets J3 Bots' own tools run without an approval in every permission mode. Without it, a supervised bot's every `say` waits on an approval card.
  - `--disallowedTools` removes the harness tools that reach a person or vanish with the session: the question tool, plan mode, the cron, wake-up and loop tools, and push notifications. A removed tool is absent from the model's tool list.

For Codex:

- `homePath` points at a J3-owned directory, which the engine passes as `CODEX_HOME`. Its `config.toml` carries:
  - `developer_instructions`: the base prompt. It is read at every thread start, so a changed prompt applies to sessions started after the change.
  - `[mcp_servers.j3]` with `command` and `args`, and `default_tools_approval_mode = "approve"`, the Codex counterpart of `--allowedTools`. The server's name must not contain a dot: T3 Code skips such names when it tags servers with the thread id (**Read**).
- Per-bot text goes into the workspace's `AGENTS.md`, because one Codex process serves every thread on the instance and the instance's settings are shared by all bots.

A J3-owned home needs nothing from the operator's own provider home when the provider is reached through an API endpoint: Claude Code takes `ANTHROPIC_BASE_URL` and `ANTHROPIC_AUTH_TOKEN` from the instance environment; Codex takes a `model_provider` entry in `config.toml` whose `env_key` names a variable in the instance environment. The engine has no sign-in flow for Claude Code or Codex instances: its `provider.auth.subscribe` answers "This provider does not support sign-in in T3 Code". A subscription sign-in into a J3-owned home is still open; see [open question 2](../open-questions.md).

The operator can inspect the engine through T3 Code's own web interface, reached with a pairing link J3 Bots prints on request.

## Behaviors J3 Bots designs around

Each of these was found by reading or running the engine and would break a naive design.

**An engine restart cancels what was running and holds what was queued.** The running run ends `cancelled`. A pending approval or question ends `cancelled` with `responseCapability: {type: "not_resumable"}`, so its card must close. Runs that were queued stay queued with `queueHeld: true`, and `queue.resume` starts them. **Verified**. A provider error holds the queue the same way, and a new run queued behind a held queue is held too; a usage limit makes the queue wait without holding it, until the reset; a message stamped as coming from a user on a web or mobile client releases a held queue (**Read** at `db51b67`, `Orchestrator.ts`, `startNextQueuedRun` and `message.dispatch`). A queued run that would move the thread to a new provider session, after its model or provider changed, while the replaced session still runs background work holds the queue too, and holds it again on every resume until that work ends (**Read**, `Orchestrator.ts`, `startNextQueuedRun`, the `restart_and_resume` switch). J3 Bots' adapter resumes a held queue once per hold, never a Stop's, which is why the two cannot loop.

**A start can be queued.** `start_immediately` does not refuse a thread with an active run: it queues the new run behind it, exactly as `queue_after_active` would, and the active run can be one the engine started itself (**Read** at `db51b67`, `Orchestrator.ts`, `message.dispatch`: `shouldQueue` when an active run exists and the mode starts or queues a run). So the adapter's busy check is only a pre-check, and a start can be accepted as `queued`.

**A steer does not always steer.** The engine turns a steer into a new turn when the target run or its provider turn has already completed, and queues it behind the running turn when the provider can neither steer nor restart, or the target is a compaction or a sign-out (**Read** at `db51b67`: `Orchestrator.ts`, `CommandPolicy.ts` `resolveMessageDispatchIntent`). A steer to a run whose provider turn has not started yet becomes a queued run marked to steer that run when it starts (`steerWhenReadyRunId`); when the target's provider turn starts, the engine cancels the carrier and steers the same message in (`queued-message.promote-to-steer`), and if the target ends first the carrier runs on its own (**Read**). A steer still pending when its run settles is dispatched again by the engine as a follow-up run with the same message id, in its place among waiting runs, unless Stop ended the run: then the steer is marked cancelled and the engine adds a "Steer delivery not confirmed" notice to the run (**Read**, `requeueUnreadSteers`, run after the run settles, before each `message.dispatch` and at recovery). A follow-up of a cancelled run is queued held. A steer into a run Stop already reached is refused with a rejected receipt (**Read**, `dispatchSteerIntoRun`).

How a provider takes a steer decides which of these happen (**Read** at `db51b67`, the adapters' `capabilities`, `CommandPolicy.decideSteeringExecution`):

| Provider | Steers a running turn | Restarts it with the steer | What a steer becomes |
| --- | --- | --- | --- |
| Claude Code | Yes | No | Taken in the running turn, or requeued if the turn ends first |
| Codex | Yes | Yes | Taken in the running turn, or requeued if the turn ends first |
| ACP agents, including the scripted agent | No | Yes | The engine interrupts the run and starts a new attempt of the same run with the steer as its message: one turn, taken unless Stop ends it first |
| GitHub Copilot through the ACP registry | No | No | A new turn after the running one (`new-turn`) |

**Stop holds the queue; it does not empty it.** `thread.stop` interrupts the active run and marks every queued run `queueHeld`, cancelling only buffered provider notifications (**Read** at `db51b67`, `Orchestrator.ts`, the thread stop path). J3 Bots' Stop must end what it dispatched, so the adapter follows `thread.stop` with `queued-run.cancel` for each queued run of the thread. Between the two, a message the engine counts as a user's releases the hold (**Read**, `sentByUserFromClient`), and J3 Bots' dispatches are such messages (`createdBy: "user"`, `creationSource: "web"`): a dispatch sent in that window starts a held run that the cancels then miss. The server sends none while a Stop is unsettled.

**A snapshot has no history.** A thread snapshot is the current projection with the highest event sequence of the thread (**Read** at `db51b67`, `ProjectionStore.ts`, `getThreadSnapshot`). Runs, turn items and requests carry their state but no sequence of their own, so after a snapshot the adapter cannot tell which runs ended after a given cursor. Its replacement lists more than what was missed, and the server's reconciliation tolerates repeats.

**The engine names the attachment.** `attachments.createUploadUrl` mints the attachment id and returns an upload URL that is valid for ten minutes; the bytes are posted to it once, and posting different bytes under the same id fails (**Read** at `db51b67`, `assets/AttachmentUpload.ts`, `packages/contracts/src/assets.ts`). Its input takes a trimmed name of 1 to 255 characters and a trimmed media type of 1 to 100; an image must name one of the four inline types exactly and be 1 byte to 10 MiB, any other file 1 byte to 50 MiB (**Read**, `AttachmentCreateUploadUrlInput`). A message's text has no length limit of its own (**Read**, `orchestrationV2.ts`). An upload no message names is removed after 24 hours, and a claimed upload stays as the source of copies until then (**Read**, `attachmentStore.ts`). A message carries at most 100 files; an image the model sees inline (GIF, JPEG, PNG or WebP) is at most 10 MiB, all of them together at most 80 MiB; other files 1 byte to 50 MiB (**Read**, `packages/contracts/src/chatAttachment.ts`).

**Interrupting a run can lose a delegated task's result.** A delegated task's completion is delivered to the parent run that started it. J3 Bots treats an interrupt as able to drop that delivery (**Assumed**: reported from the source at the pin, not yet traced in these notes), so it never interrupts a run to end it after its delivery. Only the operator's Stop ends a run.

**`send_to_user` only echoes.** The engine's tool returns its input with "Shown to the user" and does nothing else; its text exists only as the tool call in the turn's items (**Read** at `db51b67`, `apps/server/src/mcp/toolkits/message/handlers.ts`). The adapter reads it from there as host speech.

**Secret requests have their own answer path.** A `request_secret` call becomes a `secret_request` turn item with a label, a reason, an optional URL and placeholder, and a status (pending, saved, declined, cancelled). It is answered by the `secrets.answerRequest` RPC with the thread, the item and `save`, `decline` or `reference`, not by `runtime-request.respond`; a second answer fails as already answered (**Read** at `db51b67`, `packages/contracts/src/secretRequest.ts`, `orchestrationV2.ts`, `rpc.ts`, and `apps/server/src/ws.ts`).

**The engine starts runs nobody dispatched.** Three cases are known. If background work was running when the engine restarted, the engine sends the session its own continuation message (`createdBy: "agent"`, `creationSource: "server"`, beginning "Note: the T3 server restarted") and a new run starts (**Verified** on Claude Code); J3 Bots turns this off ([Provisioning](#provisioning)). If a command the harness ran in the background finishes after its turn ended, the harness's notice arrives as a new run (`createdBy: "agent"`, `creationSource: "provider"`; **Verified** on Claude Code). At a usage limit's reset the engine dispatches "Continue where you left off." with `usageLimitContinuationOfRunId` naming the thread's latest run, if that run failed at the limit, the reset is less than a day past, and the thread is not archived, settled, snoozed or waiting on a request (**Read** at `db51b67`, `UsageLimitRecoveryWorker.ts`, `limitRecoveryCommand`). Every run names the message that started it (`userMessageId`); the adapter matches runs to dispatches by that id, taking it from the run's first attempt. A usage-limit continuation is reported as a `continuation` of the run it names; any other run is a `background` turn. Neither closes a wake by itself, and anything the bot says in them still comes through `say`.

**Tool calls are turn items.** A call to an MCP tool becomes a `dynamic_tool` turn item, `running` while the call is in progress, with the call's full input: Codex names it `j3.say` (`CodexAdapterV2.ts`, `projectCodexDynamicToolItem`), Claude Code `mcp__j3__say` (`ClaudeAdapterV2.ts`, `ensureToolCallStarted`), and ACP agents carry the MCP identity (`provider-acp`, `adapter.ts`). **Read** at `db51b67`. The item is committed by the engine while the harness calls the tool, with no ordering against the request the `j3` bridge receives, so it may appear after that request. That the item's input equals the arguments the bridge receives, and that calls from a harness's own subagents appear the same way, is **Assumed** and checked by the conformance suite.

**Provider sessions are unloaded after 30 minutes idle.** The next wake starts a new provider process and resumes the conversation natively. This is the normal state for a bot, not an error. It is also when a changed system-prompt file takes effect. **Read**. `provider-session.detach` unloads one on demand, and the next turn resumes natively. **Verified**.

**Supervised Codex cannot write.** T3 Code runs a Codex thread in `approval-required` mode with approval policy `untrusted` and a read-only sandbox (**Read**). An approval lets the command run, but still inside that sandbox: an approved write failed with "Read-only file system" (**Verified**). `auto-accept-edits` gives a workspace-write sandbox (**Read**). See [Security](security.md#permission-modes).

**Claude Code deletes its own transcripts after 30 days.** A bot that was silent for a month cannot resume natively; the engine falls back to a new session with a summary. J3 Bots does not depend on a session living that long: it can rebuild a session from memory and the recent conversation at any time.

**Cost per dispatch grows with the number of runs in a thread** unless a compaction exists. J3 Bots rotates a bot's main session after a threshold of runs or tokens. See [Server](server.md#sessions).

**There is no admission control.** The engine will start as many provider processes as it is asked to. J3 Bots' wake dispatcher enforces the concurrency limit.

**Migrations go forward only.** Once an engine upgrade commits, the older version refuses the database. J3 Bots copies the engine's database files before every upgrade.

**Messages sent through `/mcp` get a note prepended** saying they did not come from the user. Messages sent through the client RPC do not. J3 Bots uses the client RPC and writes its own wake envelope.

**The engine always adds its own instructions and tools.** Whenever its MCP server is attached to a session, which is always, T3 Code adds its own text: on Claude Code appended to the system prompt (6,245 bytes at `9bb92a4`, **Read**); on Codex sent as five `additionalContext` entries with every `turn/start` (6,001 bytes with device access off, **Verified**). It covers delegation and subagents, thread tools, secret requests, charts and the preview browser, pull request linking, and, for Claude, a tool for showing text mid-turn. Its tool list comes with it. There is no setting that removes either; only the device section can be turned off. J3 Bots' base prompt names the parts it replaces. See [Prompt architecture](../prompts/architecture.md#coexisting-with-the-host).

## Footprint

Measured on 2026-11-20 on release `4969`, on an x86-64 Linux laptop, with providers reached through an API proxy. The target host is a Raspberry Pi; these numbers bound the design until they are repeated there. **Verified**.

| What | Resident memory |
| --- | --- |
| Engine, idle, no session loaded | 450 to 490 MB |
| Claude Code, per loaded session | about 230 MB, one CLI process per session |
| Codex, per instance | about 150 MB, one app-server shared by all its sessions |
| `j3` bridge, per loaded session, both harnesses | one process each; 50 MB when written as a plain Node script |

A turn adds no measurable memory beyond its loaded session. Codex keeps a session's bridge process until the session unloads, so a host with many recently active bots holds many bridges: the bridge must be a thin relay, and its runtime is chosen for size.

| Trivial turn ("reply ok"), input tokens per model call | Claude Code (Haiku 4.5) | Codex (gpt-5.6-luna) |
| --- | --- | --- |
| Under the engine | 59,100 to 59,800 | 14,800 |
| Of which cache reads when the session is warm | 59,100 to 59,700 | 12,900 to 14,600 |
| The same harness alone, same home, same prompt file | 37,400 | not measured |

About 22,000 of Claude Code's tokens per call are the engine's text and tool list. A turn that calls a tool pays the whole context once per model call. On a turn that resumes a session, the engine reports the resumed transcript's earlier usage as `otherUsage`; it is not new spend and is not counted.

Latency was dominated by the provider: about 4 seconds from dispatch to a one-word answer, with the provider session loaded or not. Starting the run took 0.1 to 0.3 seconds on Claude Code and up to 0.9 on a cold Codex instance.

## Upgrading the engine

1. Change the version and commit in `engine.json`, run `pnpm vendor:t3-contracts`, and move the catalog's Effect packages to the versions T3 Code pins at that commit. The protocol changes show up as type errors in `packages/engine-t3`.
2. Run the adapter conformance suite against the new version: start an isolated engine, create a project and a thread, dispatch messages to the scripted agent, receive the stream, answer an approval and a question, queue a start behind a running turn, steer a running turn (taken by restart) and a turn that has not started (held, then taken or run as its follow-up), stop a session with a waiting turn, a held queue and a message sent mid-Stop, replay an accepted and a rejected command id, see a `j3` tool call recorded and closed, fail a turn before it starts, stage and send an attachment, resume a subscription after a dropped socket and after an engine restart, from a cursor old enough to get a replacement, and synchronize. Steers taken in the running turn, requeued unread, or dropped by Stop need a provider that steers without restarting; they run as an opt-in test on Claude Code or Codex, which needs a model.
3. If it passes, release. On the operator's machine the upgrade stops the engine, copies its database files, starts the new version and checks the descriptor.
4. If the new engine fails to start, restore the copied files and the previous binary.

The conformance suite is the adapter's main test. It exercises the real protocol against the real server, which is the only thing that can tell us an upgrade is safe.

**The scripted agent.** The suite spends no allowance. Its turns run on a small Agent Client Protocol agent that J3 Bots owns, registered in the engine as a provider instance with driver `acpRegistry` and `{source: "local", commandPath, commandArgs}`. It needs no model and no network. A keyword in the request chooses what it does: answer at once, ask for a permission (`session/request_permission`, which the engine shows as an approval), ask a question (`elicitation/create`, shown as a question whose answers are keyed by the form's field names), or stream until it receives `session/cancel`. The engine sends it the request wrapped as `<t3_code_instructions>…</t3_code_instructions>` followed by `<user_request>…</user_request>`. **Verified** on release `4969` for all four, plus resuming after a dropped socket.

J3 Bots provisions it like any other harness: `ProviderInstance` has an `acp-command` kind (a command and its arguments) next to Claude Code and Codex, and the conformance suite starts the engine through the same adapter layer with only that instance.

T3 Code's own replay provider is the same mechanism, an ACP agent the engine seeds only on a development server. Its fake CLI is a helper for its own tests, not a provider. Neither is usable from a release build, and the scripted agent replaces both.

The behavior evals, and one short turn on each real harness before a release, still need a model.
