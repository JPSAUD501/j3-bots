# T3 Code as an engine

What J3 Bots knows about T3 Code, how it knows it, and where to look. Source references are to `pingdotgg/t3code` at commit `9bb92a4` (2026-11-19). Paths are relative to that repository.

## Verified on a running server

Both probes ran on 2026-11-20 against `t3@0.1.11-nightly.20261119.4941` on Linux arm64.

**An isolated instance is independent.** `t3 serve --base-dir <tmp> --port <p> --host 127.0.0.1 --no-browser` created a fresh data directory with its own database, settings, secrets and environment id. `t3 thread list --base-dir <tmp>` saw none of the main instance's projects.

**A third-party process can use the client RPC.** A sixty-line Node script with no T3 Code or Effect dependency:

1. read `GET /.well-known/t3/environment` without authentication: `serverVersion`, `orchestrationProtocolVersion: 2`, 75 capabilities;
2. minted a token with `t3 auth session issue --base-dir <tmp> --scope orchestration:read --scope orchestration:operate --token-only`;
3. exchanged it at `POST /api/auth/websocket-ticket/rpc` for `{ticket, expiresAt}`;
4. opened `ws://127.0.0.1:<p>/ws?orchestrationProtocol=2&wsTicket=<ticket>`;
5. sent `{"_tag":"Request","id":"2","tag":"orchestration.subscribeShell","payload":{},"headers":[]}` and received a `Chunk` whose first value had `kind: "snapshot"`.

String request ids were accepted.

**A CLI-minted token does not work on `/mcp`.** The same kind of token was rejected there with `invalid_mcp_credential`. `/mcp` accepts only its own OAuth client sessions.

## Read in source

### Protocol

| Fact | Where |
| --- | --- |
| `/ws` route; `orchestrationProtocol` must be 2 or the server answers 426 | `apps/server/src/ws.ts` |
| JSON serialization, one RPC message per WebSocket text message | `apps/server/src/ws.ts` (`RpcSerialization.layerJson`) |
| A bearer header on the upgrade is accepted without a ticket | `apps/server/src/auth/EnvironmentAuth.ts` (`authenticateWebSocketUpgrade`) |
| MCP client sessions are rejected on every route but `/mcp` | `apps/server/src/auth/EnvironmentAuth.ts` (`rejectMcpClientAudience`) |
| Subscriptions may run eight chunks ahead of acks | `apps/server/src/terminal/OutputProtocol.ts` |
| Scopes required per RPC | `apps/server/src/auth/RpcAuthorization.ts`, `packages/contracts/src/clientRpcPermissions.ts` |
| CLI sessions last 30 days and do not renew | `apps/server/src/auth/SessionStore.ts`, `docs/internals/environment-auth.md` |
| Command union, including `thread.create`, `message.dispatch`, `run.interrupt`, `thread.stop`, `runtime-request.respond`, `queue.resume` | `packages/contracts/src/orchestrationV2.ts` |
| Thread and shell stream items; resume with `afterSequence`; overlap deduplicated by sequence | `packages/contracts/src/orchestrationV2.ts`, `apps/server/src/ws.ts` |
| Events carry whole entities, coalesced in 50 ms windows | `apps/server/src/orchestration-v2/ThreadLiveEventCoalescer.ts` |
| Client messages are stamped `createdBy: "user"`, `creationSource: "web"` by default | `apps/server/src/ws.ts` |
| Attachment upload: `attachments.createUploadUrl`, then POST the bytes | `packages/contracts/src/assets.ts`, `apps/server/src/http.ts` |
| `packages/contracts` depends only on `effect`, pinned to 4.1.3, and ships TypeScript source | `packages/contracts/package.json`, `pnpm-workspace.yaml` |

### Prompt levers

| Fact | Where |
| --- | --- |
| Claude: preset system prompt plus an addition; `--append-system-prompt-file` in launch arguments is merged in; a relative path resolves in the thread's project folder | `apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts`, `docs/user/providers-claude.md` |
| Codex: no developer instructions set by T3 Code; launch arguments pass `-c key=value`; one app-server serves many threads | `apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.ts`, `docs/user/providers-codex.md` |
| T3 Code's own instruction text and its measured size | `packages/provider-core/src/server/orchestrationInstructions.ts`, `runtimeInstructions.ts`, `apps/server/src/provider/agentContextBudget.json` |
| No setting disables the orchestration instructions or adds MCP servers | `packages/contracts/src/settings.ts` |
| Provider instance fields: binary, home, launch arguments, environment | `packages/contracts/src/settings.ts`, `packages/contracts/src/providerInstance.ts` |
| `T3CODE_THREAD_ID` is set on the Claude process and on each stdio MCP server Codex starts | `ClaudeAdapterV2.ts`, `CodexAdapterV2.ts`, `apps/server/src/preview/PortScanner.ts` |
| Notes prepended to scheduled, agent-sent and MCP-sent messages | `packages/contracts/src/orchestrationV2.ts`, `apps/server/src/orchestration-v2/ProviderTurnStartService.ts` |

### Lifecycle

| Fact | Where |
| --- | --- |
| Auto-settle after 7 idle days by default; `null` disables | `packages/contracts/src/settings.ts`, `apps/server/src/orchestration-v2/ThreadSettlementService.ts` |
| Idle provider sessions are released after 30 minutes | `apps/server/src/orchestration-v2/ProviderSessionManager.ts` |
| What holds a queue and what releases it | `apps/server/src/orchestration-v2/Orchestrator.ts`, `ProviderRuntimeRecoveryService.ts` |
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
