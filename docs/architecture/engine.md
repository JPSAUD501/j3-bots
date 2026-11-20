# Engine

J3 Bots runs a stock T3 Code server and drives it as a headless client. This document covers how the engine is installed, isolated, connected to, configured and upgraded, and which of its behaviors J3 Bots has to design around.

Labels **Verified**, **Read** and **Assumed** are defined in the [documentation index](../README.md). Sources for every claim are in [research/t3-code.md](../research/t3-code.md).

## Isolation

The engine is a separate T3 Code instance that belongs to J3 Bots. It shares nothing with a T3 Code the operator may already use for coding.

- **Own data directory.** The engine runs with `--base-dir <J3_HOME>/engine`. A fresh directory gets its own database, settings, secrets and environment identity. **Verified**: an instance started this way came up with a different environment id and no projects or threads from the main instance.
- **Loopback only.** `--host 127.0.0.1` and an explicit `--port`. Without an explicit port, a second instance picks any free one. **Read**.
- **Supervised by J3 Bots.** The J3 Bots server starts the engine as a child process (`t3 serve --no-browser`) and restarts it if it exits. T3 Code's own service installer allows one service per user and refuses a second data directory, so J3 Bots cannot use it. **Read**.
- **Not inside a Git checkout.** `J3_HOME` must not sit under a repository: T3 Code treats any folder inside one as part of it, which would turn on checkpointing for bot workspaces. **Read**.

What is still shared with the machine:

- **Provider homes.** By default Claude Code uses `~/.claude` and Codex uses `~/.codex`. J3 Bots gives each engine provider instance its own home directory, so bots do not inherit the operator's coding instructions, hooks, skills or MCP servers. See [open question 3](../open-questions.md).
- **Managed policy.** `/etc/t3code/policy.json` on Linux applies to every T3 Code instance on the machine, including the engine. **Read**.

## Version pinning

J3 Bots names one exact T3 Code version. The engine binary is the standalone release archive for the platform, downloaded once, checked against the release's `SHA256SUMS`, and stored under `<J3_HOME>/engine/runtime/<version>/`.

At startup the adapter reads the engine's public descriptor and refuses to continue if the server version or the orchestration protocol version is not the pinned one. **Verified**: `GET /.well-known/t3/environment` returns `serverVersion` and `orchestrationProtocolVersion` without authentication.

## Connecting

The engine exposes two interfaces. J3 Bots uses the one T3 Code's own clients use.

| Interface | What it is | J3 Bots' use |
| --- | --- | --- |
| `/ws` | Effect RPC over WebSocket, JSON frames. Commands, queries and live subscriptions. | Everything |
| `/mcp` | MCP over HTTP with OAuth. Request and response only; no push. | Not used by J3 Bots. Bots use it from inside their sessions, as T3 Code intends. |

The connection sequence:

1. **Mint a token.** `t3 auth session issue --base-dir <engine dir> --scope orchestration:read --scope orchestration:operate --json`. This works without a sign-in because the CLI opens the engine's database directly. The token lasts 30 days and does not renew, so the server mints a new one at every start and before expiry. **Verified** (minting), **Read** (lifetime).
2. **Open the socket.** `ws://127.0.0.1:<port>/ws?orchestrationProtocol=2`, authenticated either with an `Authorization: Bearer` header on the upgrade or with a five-minute ticket from `POST /api/auth/websocket-ticket/rpc`. **Verified** with the ticket flow from a plain Node process with no T3 Code dependency.
3. **Subscribe.** `orchestration.subscribeShell` streams every thread's status, pending requests and last message. `orchestration.subscribeThread` streams one thread's events. **Verified** for the shell snapshot.

Protocol facts the adapter depends on:

- Each WebSocket message is one JSON object: `Request`, `Ack`, `Interrupt`, `Ping` from the client; `Chunk`, `Exit`, `Defect`, `Pong` from the server. **Read**; `Request` and `Chunk` **Verified**.
- **Every stream chunk must be acknowledged.** The server lets a subscription run at most eight chunks ahead of the client's acks, then stalls. **Read**.
- **Events replace whole entities.** A streaming assistant message arrives as its full text so far, at most every 50 ms. The client upserts by id and never applies deltas. **Read**.
- **Resume by sequence.** The client remembers the last sequence it applied and resubscribes with `afterSequence`. If that point was pruned, the server sends a fresh snapshot. Events may overlap; the client drops anything at or below what it has. **Read**.
- **Commands are idempotent by `commandId`.** Replaying the same id is safe. J3 Bots uses the wake id, so a retry after a crash cannot start a second turn. **Read**.
- **Revoking the session closes the socket.** The adapter must reconnect and resume at any time. **Read**.

A token with `orchestration:operate` can start a full-access agent. It is equivalent to a shell as the server's user and is handled as such.

## What J3 Bots uses, and what it leaves alone

J3 Bots keeps the engine surface it touches small, because every part it touches is a part an upgrade can break.

| Engine capability | Used | How |
| --- | --- | --- |
| Projects | Yes | One project per bot, on the bot's workspace folder |
| Threads | Yes | The bot's main session and its side sessions |
| `message.dispatch` with queue and steer | Yes | Every wake |
| Run interrupt and thread stop | Yes | "Stop" |
| Runtime requests (approvals, questions) | Yes | Shown as cards; answered with `runtime-request.respond` |
| Model selection and runtime mode per thread | Yes | Per-bot model and permission mode |
| Attachment upload | Yes | Files the operator sends |
| Provider status and usage limits | Yes | Engine health, usage view, blocked state |
| Fresh context on a dispatch | Yes | Fresh start, session rotation |
| Scheduled tasks and webhooks | No | J3 Bots schedules its own wakes. See [decision 0005](../decisions/0005-j3-bots-owns-wakes.md) |
| Thread-to-thread messaging tools | No | Bots message each other through J3 Bots |
| Worktrees, checkpoints, diffs, pull requests | No | Coding features |
| T3 Connect, pairing, guest links | No | J3 Bots has its own client access |
| Settlement, snooze, pinning | No | Sidebar features of T3 Code's clients; auto-settle is turned off |

## Provisioning

Before first start, J3 Bots writes `<engine dir>/userdata/settings.json`. The engine reads it at startup and watches it afterwards. **Read**.

| Setting | Value | Why |
| --- | --- | --- |
| `sidebarAutoSettleAfterDays` | `null` | A bot's session must not be settled after a week of quiet. A settled thread loses usage-limit auto-resume and restart continuation. |
| `sidebarAutoSettleOnMerge` | `false` | Not applicable. |
| `idleCompaction` (Claude) | `beforeCacheExpires` | An unattended bot has nobody to press a compact button. |
| `autoResumeLimitedThreads` | `true` | A bot that hit a limit should continue at the reset. |
| `enableAgentDeviceAccess` | `false` | Bots do not drive phone simulators, and turning this off removes T3 Code's device instructions from every session. |
| `providerInstances` | Generated | One instance per provider the operator enabled, each with its own home, launch arguments and environment. |

Provider instances are where J3 Bots attaches its prompt and its tools. For Claude Code:

- `homePath` points at a J3-owned config directory.
- `launchArgs` includes `--append-system-prompt-file .j3/system.md`. T3 Code merges this into the system prompt it sends and resolves a relative path inside each thread's project folder, so one instance serves every bot and each gets its own file. **Read**.
- The J3 Bots tools are registered as an MCP server in that config directory.

For Codex, the base prompt goes into the instance's own `CODEX_HOME` configuration, and per-bot text into the workspace's `AGENTS.md`, because Codex instance settings are shared by all threads. **Read** for the constraint; the exact Codex keys are **Assumed**.

Until J3 Bots has its own provider settings screen, the operator signs in to providers and inspects the engine through T3 Code's own web interface, reached with a pairing link J3 Bots prints on request.

## Behaviors J3 Bots designs around

Each of these was found by reading the engine and would break a naive design.

**A held queue is not released by automated sends.** A server restart, a stop, a provider error or a usage limit puts a thread's queue on hold. Only a message stamped as coming from a user on a web or mobile client releases it, or an explicit `queue.resume`. J3 Bots dispatches over the client RPC, where every message is stamped that way, and sends `queue.resume` when it reconnects after an engine restart.

**Provider sessions are unloaded after 30 minutes idle.** The next wake starts a new provider process and resumes the conversation natively. This is the normal state for a bot, not an error. It is also when a changed system-prompt file takes effect.

**Claude Code deletes its own transcripts after 30 days.** A bot that was silent for a month cannot resume natively; the engine falls back to a new session with a summary. J3 Bots does not depend on a session living that long: it can rebuild a session from memory and the recent conversation at any time.

**Cost per dispatch grows with the number of runs in a thread** unless a compaction exists. J3 Bots rotates a bot's main session after a threshold of runs or tokens. See [Server](server.md#sessions).

**There is no admission control.** The engine will start as many provider processes as it is asked to. J3 Bots' wake dispatcher enforces the concurrency limit.

**Migrations go forward only.** Once an engine upgrade commits, the older version refuses the database. J3 Bots copies the engine's database files before every upgrade.

**Messages sent through `/mcp` get a note prepended** saying they did not come from the user. Messages sent through the client RPC do not. J3 Bots uses the client RPC and writes its own wake envelope.

**The engine always adds its own instructions.** Whenever its MCP server is attached to a session, which is always, T3 Code appends its own text to the system prompt: 6,245 bytes for Claude Code and 7,639 for Codex at the pinned commit. It covers delegation and subagents, thread tools, secret requests, charts and the preview browser, pull request linking, and, for Claude, a tool for showing text mid-turn. There is no setting that removes it; only the device section can be turned off. J3 Bots' base prompt names the parts it replaces. See [Prompt architecture](../prompts/architecture.md#coexisting-with-the-host).

## Upgrading the engine

1. Change the pinned version in one place.
2. Run the adapter conformance suite against the new version: start an isolated engine, create a project and a thread, dispatch a message with a replay provider, receive the stream, answer an approval, interrupt a run, resume a subscription after a dropped socket.
3. If it passes, release. On the operator's machine the upgrade stops the engine, copies its database files, starts the new version and checks the descriptor.
4. If the new engine fails to start, restore the copied files and the previous binary.

The conformance suite is the adapter's main test. It exercises the real protocol against the real server, which is the only thing that can tell us an upgrade is safe.
