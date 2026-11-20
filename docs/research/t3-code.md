# T3 Code as an engine

What J3 Bots knows about T3 Code, how it knows it, and where to look. Paths are relative to the `pingdotgg/t3code` repository. Source references are to commit `9bb92a4` (2026-11-19) unless a row names `db51b67`, the commit of release `4969`.

## Releases

| Release | Commit | Note |
| --- | --- | --- |
| `0.1.11-nightly.20261119.4941` | `ff9efe8` | The first M0 probes. The engine does not give MCP servers that Codex starts `T3CODE_THREAD_ID`. |
| `0.1.11-nightly.20261120.4969` | `db51b67` | Pinned in `engine.json`. The oldest release the bot tool bridge works on with Codex. `9bb92a4` plus ten commits, including pull request 39414, which adds that variable. |

A nightly's title names its commit. A fact read at one commit applies to a release only if the release's commit contains it.

## Verified on a running server

Unless noted, each probe ran on 2026-11-20 on Linux, in an isolated instance (`t3 serve --base-dir <scratch> --port <p> --host 127.0.0.1 --no-browser`) that shared nothing with the operator's own engine. Claude Code and Codex were reached through API proxies, using the cheapest model each offers (Claude Haiku 4.5, gpt-5.6-luna).

### Access

Against `4941` on arm64:

**An isolated instance is independent.** It created a fresh data directory with its own database, settings, secrets and environment id. `t3 thread list --base-dir <tmp>` saw none of the main instance's projects.

**A third-party process can use the client RPC.** A sixty-line Node script with no T3 Code or Effect dependency:

1. read `GET /.well-known/t3/environment` without authentication: `serverVersion`, `orchestrationProtocolVersion: 2`, 75 capabilities;
2. minted a token with `t3 auth session issue --base-dir <tmp> --scope orchestration:read --scope orchestration:operate --token-only`;
3. exchanged it at `POST /api/auth/websocket-ticket/rpc` for `{ticket, expiresAt}`;
4. opened `ws://127.0.0.1:<p>/ws?orchestrationProtocol=2&wsTicket=<ticket>`;
5. sent `{"_tag":"Request","id":"2","tag":"orchestration.subscribeShell","payload":{},"headers":[]}` and received a `Chunk` whose first value had `kind: "snapshot"`.

String request ids were accepted. A bearer header on the upgrade, without a ticket, was accepted as well (on `4969`).

**A CLI-minted token does not work on `/mcp`.** The same kind of token was rejected there with `invalid_mcp_credential`. `/mcp` accepts only its own OAuth client sessions.

### The turn protocol

Against `4941` and `4969` on x86-64, on Claude Code, Codex and the scripted agent described in [Engine](../architecture/engine.md#upgrading-the-engine).

Every call is a `Request` frame. A unary call ends with one `Exit` frame: `{"_tag":"Exit","requestId":…,"exit":{"_tag":"Success","value":…}}`, or `"Failure"` with a cause. A subscription sends `Chunk` frames, `{"_tag":"Chunk","requestId":…,"values":[…]}`, and the client answers each with `{"_tag":"Ack","requestId":…}`. The server sends `{"_tag":"Ping"}` and expects `{"_tag":"Pong"}`. A client that stopped acknowledging received a bounded number of chunks and then nothing until it acknowledged them.

The calls a turn needs:

| Step | Request tag and payload | Result |
| --- | --- | --- |
| Create a project | `projects.mutate` `{type: "project.create", commandId, projectId, title, workspaceRoot}` | the project. A folder that already has a project fails with a conflict. |
| Create a thread | `orchestration.dispatchCommand` `{type: "thread.create", commandId, threadId, projectId, title, modelSelection: {instanceId, model}, runtimeMode, interactionMode: "default", branch: null, worktreePath: null, createdBy: "user", creationSource: "web"}` | `{sequence}` |
| Send a message | `{type: "message.dispatch", commandId, threadId, messageId, text, attachments: [], dispatchMode: {type: "start_immediately"}, createdBy: "user", creationSource: "web"}` | `{sequence}` |
| Answer an approval | `{type: "runtime-request.respond", commandId, threadId, requestId, decision: "accept"}` | `{sequence}` |
| Answer a question | `{type: "runtime-request.respond", commandId, threadId, requestId, answers: {<question id>: <answer>}}` | `{sequence}` |
| Interrupt | `{type: "run.interrupt", commandId, threadId, runId, reason}` | `{sequence}` |
| Release a held queue | `{type: "queue.resume", commandId, threadId}` | `{sequence}` |
| Unload a provider session | `{type: "provider-session.detach", commandId, threadId, providerSessionId, reason}` | `{sequence}` |
| Watch | `orchestration.subscribeThread` `{threadId, afterSequence?}` | stream |
| Read the whole thread | `orchestration.getThreadProjection` `{threadId}` | runs, messages, requests, sessions |

A message sent with `dispatchMode: {type: "queue_after_active"}` while a run was active became a `queued` run. `steer_active`, `restart_active` and `defer_start` were not exercised.

`subscribeThread` without `afterSequence` sends a `snapshot` item first, then `event` items, each `{kind: "event", sequence, event: {type, threadId, runId, payload, …}}`. With `afterSequence` it sends only the events after it. The event types seen in a turn: `thread.create`, `message.dispatch`, `run.created`, `run.updated`, `run-attempt.created`, `run-attempt.updated`, `provider-session.attached`, `provider-session.updated`, `provider-session.detached`, `provider-thread.updated`, `provider-turn.updated`, `turn-item.updated`, `message.updated`, `node.updated`, `runtime-request.updated`, `runtime-request.respond`, `run.interrupt`, `queue.resume`, `checkpoint.captured`, `thread.metadata-updated` and `subagent.updated`. Each carries the whole entity.

- **Runs.** A run names its trigger in `userMessageId`. Statuses seen: `queued`, `starting`, `running`, `waiting`, `completed`, `interrupted`, `cancelled`. `waiting` is not a request: the provider turn completed while work it started is still open (**Read**, `RunExecutionService.ts`). A `starting` run has no `startedAt` yet and can fail before its provider turn starts. A held queued run has `queueHeld: true`.
- **Ids.** Item and request ids nest the engine's, the provider's and native ids; they ran to 287–343 characters.
- **Messages.** `message.updated` with `role: "assistant"` streams; `streaming: false` marks the final text. Assistant messages are stamped `createdBy: "agent"`, `creationSource: "provider"`.
- **Requests.** `runtime-request.updated` carries `kind`, `status` and `responseCapability`. Kinds seen: `command` (approval to run something), `user_input` (Claude Code's question tool and the scripted agent's form) and `mcp-elicitation` (Codex asking before it calls an MCP tool). The matching `turn-item.updated` items, `approval_request` and `user_input_request`, hold the text shown to the user; a `user_input_request` lists `questions`, each with an `id` and `options`. On Claude Code a question's `id` is its text; on an ACP form it is the field name. `responseCapability` is `{type: "live", providerSessionId}` while the request can be answered and `{type: "not_resumable"}` after the session that asked is gone.
- **Usage.** `provider-turn.updated` carries `turnTokenUsage` per model call. On a turn that resumes a provider session, `otherUsage` repeats the earlier turns' usage.

**Resume.** After the socket was closed mid-turn, a new socket subscribed with `afterSequence` set to the last sequence received and got the rest of the turn with no gap and no repeat. After the engine was stopped and started again, the same worked across the restart. Sequences are numbered across the whole environment, so one thread's events skip numbers; a skipped number is not a lost event.

**Idempotency.** Sending the same `message.dispatch` twice, and a third time with the same `commandId` and a new `messageId`, returned the first sequence each time and started one run.

**Restart.** With a run waiting on an approval and a second message queued behind it, the engine was stopped and started. The running run became `cancelled`; the approval became `cancelled` with `not_resumable`; the queued run stayed `queued` with `queueHeld: true` until `queue.resume` started it. A message dispatched after the restart, with nothing held, started normally. With a background command running on Claude Code at the restart, the engine dispatched its own message to the thread (`createdBy: "agent"`, `creationSource: "server"`), and a new run started. When a background command finished after its turn had ended, Claude Code's notice started a run with `creationSource: "provider"`.

**Processes.** Provider CLIs are started under `systemd-run --user --scope`, so they are not the engine's children. Stopping the engine stopped them.

**Supervised Codex.** In `approval-required`, Codex asked to approve a file write; after `accept`, the write failed with "Read-only file system".

### Provider instances

Against `4969` on x86-64.

**Settings are watched.** Adding or changing a provider instance in `settings.json` while the engine ran made it available to the next session, without a restart. A secret environment variable is stored in `userdata/secrets/` as one file per instance and variable, and appears in `settings.json` only as `{value: "", sensitive: true, valueRedacted: true}`.

**Claude Code, J3-owned home.** With `homePath` set, the CLI ran with `CLAUDE_CONFIG_DIR` pointing there. An MCP server declared in that directory's `.claude.json` was started for every session, received `T3CODE_THREAD_ID` equal to the thread id, and received the model's tool call. Launch arguments `--append-system-prompt-file .j3/system.md` (resolved in the project folder), `--allowedTools mcp__j3__*` and `--disallowedTools AskUserQuestion` all took effect: a canary instruction in the file was followed, the J3 tool ran in `approval-required` without a card, and the question tool was gone. `permissions.deny: ["Bash"]` in that directory's `settings.json` removed the shell tool. The directory needs nothing copied from the operator's own Claude Code configuration when the provider is reached through an API endpoint.

**Codex, J3-owned home.** With `homePath` set, the app-server ran with `CODEX_HOME` pointing there. In its `config.toml`, `developer_instructions` and a `[mcp_servers.j3]` server were both used; with `default_tools_approval_mode = "approve"`, the J3 tool ran without an elicitation. On `4941` the MCP server received no `T3CODE_THREAD_ID`; on `4969` it received the thread id. An `AGENTS.md` in the project folder was followed. A change to `config.toml` applied to the next new thread without a restart.

**Instruction priority.** T3 Code's text tells the model to link files by absolute path. A J3 instruction to name files by base name only was put in each layer, and the model was asked to mention a file. Without the J3 instruction the model followed T3 Code three times out of three. With it, the J3 instruction won three of three from Codex `developer_instructions`, three of three from the project's `AGENTS.md` on Codex, and two of two from Claude Code's appended prompt file. Not tested after a compaction.

**Sign-in.** The engine's sign-in stream, `provider.auth.subscribe`, answered "This provider does not support sign-in in T3 Code" for both a Claude Code and a Codex instance.

**The scripted agent.** J3 Bots' ACP agent (`packages/engine-t3/scripted-agent`), registered with driver `acpRegistry` and `{source: "local", commandPath: <node>, commandArgs: [<script>]}`, ran turns with no model: a plain answer, a permission request answered from an approval card (`allow-once` reached the agent), a form question answered with `{drink: "Tea"}`, a slow stream stopped by `run.interrupt` (the agent received `session/cancel`), a call to `send_to_user` and one to `request_secret` through the endpoint the engine's stdio bridge names, and a resume after a dropped socket. The adapter's conformance suite runs on it: all seventeen scenarios pass on `4969`, among them a steer into a running turn and into one just begun (each taken by a restart of the same run), a steer into a stopped turn refused on every repeat, and an engine killed mid-turn, after which the cut run was reported `interrupted` and the next turn completed.

### Footprint

Against `4969` on an x86-64 laptop with about 2.7 GB of free memory, measured with resident set sizes from `ps` and from the user slice. Numbers are in [Engine](../architecture/engine.md#footprint).

Token counts are the `turnTokenUsage` the engine reported for a turn asking for a one-word reply. The Claude Code baseline ran `claude -p` with the same `CLAUDE_CONFIG_DIR`, prompt file and model, outside the engine. Setting or removing `ENABLE_TOOL_SEARCH=false` made no difference on Haiku 4.5.

## Read in source

### Protocol

| Fact | Where |
| --- | --- |
| `/ws` route; `orchestrationProtocol` must be 2 or the server answers 426 | `apps/server/src/ws.ts` |
| JSON serialization, one RPC message per WebSocket text message | `apps/server/src/ws.ts` (`RpcSerialization.layerJson`) |
| MCP client sessions are rejected on every route but `/mcp` | `apps/server/src/auth/EnvironmentAuth.ts` (`rejectMcpClientAudience`) |
| Subscriptions may run eight chunks ahead of acks | `apps/server/src/terminal/OutputProtocol.ts` |
| Scopes required per RPC | `apps/server/src/auth/RpcAuthorization.ts`, `packages/contracts/src/clientRpcPermissions.ts` |
| CLI sessions last 30 days and do not renew | `apps/server/src/auth/SessionStore.ts`, `docs/internals/environment-auth.md` |
| Command union, including `thread.create`, `message.dispatch`, `run.interrupt`, `thread.stop`, `runtime-request.respond`, `queue.resume` | `packages/contracts/src/orchestrationV2.ts` |
| Overlap between a snapshot and live events deduplicated by sequence | `packages/contracts/src/orchestrationV2.ts`, `apps/server/src/ws.ts` |
| Live events coalesced in 50 ms windows | `apps/server/src/orchestration-v2/ThreadLiveEventCoalescer.ts` |
| Client commands are stamped `createdBy: "user"`; a command's own `creationSource` is kept, and `web` is used when it has none (`db51b67`) | `apps/server/src/ws.ts` |
| Attachment upload: `attachments.createUploadUrl`, then POST the bytes | `packages/contracts/src/assets.ts`, `apps/server/src/http.ts` |
| `packages/contracts` depends only on `effect`, pinned to 4.1.3, and ships TypeScript source; the platform packages are pinned to 4.1.2 (`db51b67`) | `packages/contracts/package.json`, `pnpm-workspace.yaml` |
| A requested steer becomes `queue_after_active` when the provider can neither steer nor restart its turn, or when the target is a compaction or sign-out (`db51b67`) | `apps/server/src/orchestration-v2/CommandPolicy.ts` (`resolveMessageDispatchIntent`) |
| A steer whose target run or provider turn already completed is started as a new run (`start_immediately`) (`db51b67`) | `apps/server/src/orchestration-v2/Orchestrator.ts` |
| A steer still pending when its run settles is dispatched again as a follow-up run with the same message id, in its place among queued runs; if Stop ended the run, the steer is marked cancelled and a "Steer delivery not confirmed" notice is added instead. The check runs as a reaction after the run settles, before each `message.dispatch` and at recovery (`db51b67`) | `Orchestrator.ts` (`requeueUnreadSteers` and its callers) |
| A steer to a run whose provider turn has not started becomes a queued run with `steerWhenReadyRunId`; when the target's provider turn starts, `queued-message.promote-to-steer` cancels it and steers the same message; otherwise it runs on its own (`db51b67`) | `Orchestrator.ts` |
| A provider that steers only by restart gets an interrupt and a new attempt of the same run (reason `steering_restart`), whose `userMessageId` becomes the steer's message (`db51b67`) | `CommandPolicy.ts` (`decideSteeringExecution`), `Orchestrator.ts` |
| Steering capabilities: Claude steers but cannot restart; Codex does both; generic ACP restarts only; the ACP registry inherits that, and only Copilot turns restart off (`db51b67`) | `Adapters/ClaudeAdapterV2.ts`, `Adapters/CodexAdapterV2.ts`, `packages/provider-acp/src/server/adapter.ts`, ACP registry overrides |
| A steer into a run that is not running is refused, leaving a rejected receipt: a run Stop already reached, one waiting in the queue, or one that ended any way but `completed`; only a `completed` target is turned into a new run first (`db51b67`) | `Orchestrator.ts` (`dispatchSteerIntoRun`), `CommandPolicy.ts` (`resolveMessageDispatchIntent`) |
| A run's `waiting` status means its provider turn ended while background work keeps the run open; a steer to it becomes a new run (`db51b67`) | `RunExecutionService.ts`, `CommandPolicy.ts` |
| Command receipts are reserved in the transaction that commits the command's events; a replay compares only the command id, answers an accepted one with its sequence and applies nothing, and fails a rejected one as previously rejected. A refused command writes a rejected receipt, except managed-policy and mode-ceiling refusals. Receipts are kept for good; events are pruned after a day (`db51b67`) | `EventSink.ts`, `CommandReceiptStore.ts`, `Orchestrator.ts` (`replayCommandReceipt`, `dispatchWithReceiptEffect`), `ProjectionMaintenance.ts` |
| Steps after a command's commit can fail and turn its reply into an error; commands sent while the engine starts wait in a queue of the engine's own (`db51b67`) | `Orchestrator.ts` (`offerDelegatedCompletionDeliveries`), `serverRuntimeStartup.ts` (`makeCommandGate`) |
| `message.dispatch` claims the message's pending uploads before it checks the command's receipt; a claimed upload stays as a copy source until the 24-hour sweep (`db51b67`) | `ThreadMessageIntake.ts` (`dispatchCommand`), `attachmentStore.ts` |
| A message releases held runs only when it is stamped `createdBy: "user"` with `creationSource` `web` or `mobile`, is no steer follow-up and no scheduled task's; a message sent with `creationSource: "server"` releases nothing (`db51b67`) | `Orchestrator.ts` (`sentByUserFromClient`) |
| The queue is held after a provider error, after `thread.stop`, and, while a provider switch's replaced session still runs background work, again on every resume (`db51b67`) | `Orchestrator.ts` (`startNextQueuedRun`, `restart_and_resume`) |
| An MCP tool call is a `dynamic_tool` turn item, `running` while the call is in progress, with its input: `j3.say` on Codex, `mcp__j3__say` on Claude Code, the MCP identity on ACP agents (`db51b67`) | `CodexAdapterV2.ts` (`projectCodexDynamicToolItem`), `ClaudeAdapterV2.ts` (`ensureToolCallStarted`), `provider-acp/src/server/adapter.ts` |
| Upload input: a trimmed name of 1 to 255 characters, a trimmed media type of 1 to 100; images one of four exact types (`db51b67`) | `packages/contracts/src/assets.ts` (`AttachmentCreateUploadUrlInput`) |
| `start_immediately` queues the new run behind an active run, as `queue_after_active` does (`db51b67`) | `Orchestrator.ts` (`message.dispatch`, `shouldQueue`) |
| `thread.stop` interrupts the active run and holds queued runs (`queueHeld: true`) instead of cancelling them, except buffered provider notifications; `queued-run.cancel` cancels one queued run (`db51b67`) | `Orchestrator.ts` (thread stop), `packages/contracts/src/orchestrationV2.ts` |
| A provider failure holds the queue; a usage limit makes it wait unheld until the reset; a run queued behind a held queue is held (`db51b67`) | `Orchestrator.ts` (`startNextQueuedRun`, `message.dispatch`) |
| `run.interrupt` always stops the run's remaining work; without a held queue that disposes of the run's delegated-completion cohort as stopped, so a delegated task's result is never delivered to it (`db51b67`) | `Orchestrator.ts` (`run.interrupt`, `stopRemainingWork`) |
| Thread events carry the thread shell (`OrchestrationV2AppThread`), with `archivedAt` and `limitRecovery` (`runId`, `resetAt`, `autoResume`, optional snooze and request) (`db51b67`) | `packages/contracts/src/orchestrationV2.ts` |
| A restart continuation is armed at shutdown only when `continueThreadsAfterServerUpdate` is on (default on); whether one is pending is exposed over `/mcp` and peer links, never `/ws` (`db51b67`) | `ProviderRuntimeRecoveryService.ts` (`prepareForShutdown`), `RestartContinuation.ts`, `Orchestrator.ts` (`restartContinuationPending`) |
| At a usage limit's reset the engine dispatches "Continue where you left off." with `usageLimitContinuationOfRunId` set to the thread's latest run, when that run failed at the limit, the reset is less than a day past, auto-resume is on, and the thread is not archived, settled, snoozed or waiting on a request (`db51b67`) | `UsageLimitRecoveryWorker.ts` (`limitRecoveryCommand`) |
| A thread snapshot is the current projection plus the thread's highest event sequence; runs carry no sequence of their own (`db51b67`) | `apps/server/src/orchestration-v2/ProjectionStore.ts` (`getThreadSnapshot`) |
| `subscribeThread` with `requestCompletionMarker` sends a `synchronized` item between the replay or snapshot and live events (`db51b67`) | `apps/server/src/ws.ts`, `packages/contracts/src/orchestrationV2.ts` |
| The upload endpoint mints the attachment id; its URL lasts ten minutes; different bytes under an uploaded id fail; uploads no message names are removed after 24 hours (`db51b67`) | `apps/server/src/assets/AttachmentUpload.ts`, `apps/server/src/attachmentStore.ts`, `packages/contracts/src/assets.ts` |
| At most 100 files per message; inline images (GIF, JPEG, PNG, WebP) at most 10 MiB each and 80 MiB together; other files 1 byte to 50 MiB (`db51b67`) | `packages/contracts/src/chatAttachment.ts` |
| Secret requests: a `secret_request` turn item (label, reason, optional URL, placeholder and file delivery, status pending, saved, declined or cancelled), answered by the `secrets.answerRequest` RPC with `save`, `decline` or `reference`; a second answer fails as `already_answered` (`db51b67`) | `packages/contracts/src/secretRequest.ts`, `orchestrationV2.ts`, `rpc.ts`, `apps/server/src/ws.ts` |
| `send_to_user` returns its input and does nothing else (`db51b67`) | `apps/server/src/mcp/toolkits/message/handlers.ts` |
| A dispatch's error reply over `/ws` is an `OrchestrationV2DispatchCommandError` whose cause is a `Schema.Defect` keeping the engine error's class name and message (`db51b67`) | `apps/server/src/ws.ts` |
| A command that leaves no receipt: `OrchestratorRuntimeModeAboveCeilingError` (managed policy) and `OrchestratorThreadAboveModeLimitError` (never met over `/ws`); `AttachmentClaimError` is raised before the receipt lookup (`db51b67`) | `Orchestrator.ts`, `CommandPolicy.ts`, `ThreadMessageIntake.ts` (`dispatchCommand`) |
| `queue.resume` is refused on an archived thread, during a usage limit and while worktree setup is pending, and does nothing on an empty queue; whether a replaced provider session still has background work is a runtime probe, not projected (`db51b67`) | `Orchestrator.ts` (`queue.resume`, `startNextQueuedRun`, `sessionHasBackgroundWork`) |
| `thread.stop` on a thread with no active run holds it and sets `limitRecovery.autoResume` to false (`db51b67`) | `Orchestrator.ts` (`holdStoppedThread`) |
| A Codex steer is one `turn/steer` request, with no later confirmation that it was consumed; Claude Code marks a steer `completed` when offering it to the CLI fails (`db51b67`) | `CodexAdapterV2.ts`, `ClaudeAdapterV2.ts` (the steer offer's `onError`) |
| A Claude Code subagent's tool call is recorded on the subagent's child thread with no run, never in the parent's turn (`db51b67`) | `ClaudeAdapterV2.ts` (`startSubagentToolCall`) |
| A `dynamic_tool` input whose JSON exceeds 16,384 bytes is replaced on the wire by a one-line summary (`db51b67`) | `apps/server/src/orchestration-v2/WireProjection.ts` (`summarizeDynamicValue`) |
| The WebSocket server authenticates once at the upgrade and builds one RPC server per connection, with fatal defects disabled (`db51b67`) | `apps/server/src/ws.ts` |

### Prompt levers

| Fact | Where |
| --- | --- |
| Claude: preset system prompt plus an addition; `--append-system-prompt-file` in launch arguments is merged in; a relative path resolves in the thread's project folder | `apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts`, `docs/user/providers-claude.md` |
| Codex: launch arguments pass `-c key=value`; one app-server serves many threads | `apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.ts`, `docs/user/providers-codex.md` |
| Codex: T3 Code's text goes in `additionalContext` with each turn, never in `developer_instructions`; after a compaction the engine injects it again, because Codex drops it then (`db51b67`) | `apps/server/src/provider/CodexDeveloperInstructions.ts`, `apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.ts` |
| Codex runtime modes: `approval-required` is approval policy `untrusted` with a read-only sandbox; `auto-accept-edits` is `on-request` with a workspace-write sandbox (`db51b67`) | `CodexAdapterV2.ts` (`codexRuntimeModeTurnDefaults`) |
| ACP agents: T3 Code's text and the request are sent as one prompt, `<t3_code_instructions>` then `<user_request>` (`db51b67`) | `packages/provider-core/src/server/orchestrationInstructions.ts` |
| T3 Code's own instruction text and its measured size | `packages/provider-core/src/server/orchestrationInstructions.ts`, `runtimeInstructions.ts`, `apps/server/src/provider/agentContextBudget.json` |
| No setting disables the orchestration instructions or adds MCP servers | `packages/contracts/src/settings.ts` |
| Provider instance fields: binary, home, launch arguments, environment | `packages/contracts/src/settings.ts`, `packages/contracts/src/providerInstance.ts` |
| `T3CODE_THREAD_ID` is set on the Claude process and, from pull request 39414, on each stdio MCP server Codex starts (`db51b67`) | `ClaudeAdapterV2.ts`, `CodexAdapterV2.ts` (`mcp_servers.<name>.env`), `apps/server/src/preview/PortScanner.ts` |
| A Codex stdio MCP server whose name contains a dot is not given the thread id, because Codex splits configuration keys on dots (`db51b67`) | `CodexAdapterV2.ts` (`codexStdioMcpServerNames`) |
| Provider instance `source: "local"` with a command path and arguments, for ACP agents (`db51b67`) | `packages/contracts/src/providerSetup.ts` |
| Claude Code and Codex instances have no sign-in flow in the engine (`db51b67`) | `apps/server/src/provider/ProviderAuthService.ts` |
| The replay provider is an ACP agent seeded only on a development server run from source (`db51b67`) | `apps/server/src/provider/ProviderInstanceRegistryHydration.ts` (`seedDevReplayInstance`) |
| Notes prepended to scheduled, agent-sent and MCP-sent messages | `packages/contracts/src/orchestrationV2.ts`, `apps/server/src/orchestration-v2/ProviderTurnStartService.ts` |

### Lifecycle

| Fact | Where |
| --- | --- |
| Auto-settle after 7 idle days by default; `null` disables | `packages/contracts/src/settings.ts`, `apps/server/src/orchestration-v2/ThreadSettlementService.ts` |
| Idle provider sessions are released after 30 minutes | `apps/server/src/orchestration-v2/ProviderSessionManager.ts` |
| What holds a queue and what releases it, beyond a restart | `apps/server/src/orchestration-v2/Orchestrator.ts`, `ProviderRuntimeRecoveryService.ts` |
| Dispatch reads every run of a thread unless a compaction exists | `apps/server/src/orchestration-v2/Orchestrator.ts`, `ProjectionStore.ts` |
| No global limit on concurrent runs | not found anywhere in `apps/server/src` |
| Scheduled task semantics: skipped when busy, late fixed-time runs skipped | `apps/server/src/scheduledTasks/ScheduledTaskService.ts`, `Schedule.ts` |
| One background service per user; a second data directory is refused | `apps/server/src/cloud/bootService.ts` |
| Folders inside a Git checkout are treated as part of it | `apps/server/src/project/ManagedProjectFolders.ts`, `apps/server/src/checkpointing/CheckpointService.ts` |
| Forward-only migrations; downgrade refused | `apps/server/src/cloud/servicePreflight.ts`, `docs/internals/server-updates.md` |
| Usage limits per provider are in the server config stream | `packages/contracts/src/server.ts`, `providerUsageLimits.ts` |

## What T3 Code is building in this area

Relevant upstream work, as of 2026-11-20:

- **Home** (pull request 15975, open since October, no commits since): one agent thread that manages threads across the user's machines. The closest upstream idea to a primary bot. Stalled.
- **T3 Work** (pull request 4604): a projectless assistant experience built on a third-party agent gateway. Closed, with the direction abandoned.
- **Linked environments** (several open pull requests): reading and driving threads on other machines through one. Infrastructure J3 Bots could use later to run bots on more than one host.
- **Durable workflows** (pull requests 38874, 38882, 38884): TypeScript-defined workflows with agent steps, schedules, webhooks and human questions. An automation system, not a teammate product; complementary to J3 Bots.
- **Outbound thread events for outside agents** (pull request 22595): closed. This is why J3 Bots uses the client RPC.

If upstream ships a first-party persistent-bot product, J3 Bots' reason to exist should be re-examined against it.
