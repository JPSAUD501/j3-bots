# 0027: Connector tools reach a bot through the `j3` bridge, under the bot's permission mode

**Status:** Accepted

## Context

J3 Bots holds every connector's sign-in and calls the connector itself ([decision 0026](0026-a-bot-uses-connected-services-through-j3-bots.md)). A bot still has to see the connector's tools in its harness and call them, and the server has to know which bot is calling, on both harnesses, to check the connector's grant.

What the pieces allow:

- **Only a stdio MCP server learns which session calls it, on both harnesses.** The engine gives each harness process the session's thread id (`T3CODE_THREAD_ID`); on Codex, where one app-server serves many threads, it sets it per thread only in the shell's environment and in the environment of the stdio servers it starts (**Read** in T3 Code at `59651c1`, `CodexAdapterV2.ts` and `ClaudeAdapterV2.ts`). An HTTP server the harness calls is told nothing about the session.
- **J3 Bots already has such a server.** The `j3` bridge is a stdio process per loaded session that reads that id and forwards each call to the server, which matches the call to the engine's own record of it in the bot's running turn ([Server: bot tools](../architecture/server.md#bot-tools)). That match is what keeps a local process that knows a session's id from acting as that bot's turn.
- **The bridge's tools were pre-approved as a namespace.** Claude Code ran with `--allowedTools mcp__j3__*` and Codex with `default_tools_approval_mode = "approve"` on the `j3` server, so every `j3` tool ran without asking, in every permission mode ([Security: permission modes](../architecture/security.md#permission-modes)). That is right for J3 Bots' own tools, which only reach J3 Bots. It would be wrong for a connector's: sending an email or deleting a page should ask in Supervised as a shell command does.
- **Both harnesses can pre-approve exact names.** Codex takes an approval mode per tool of a server (**Read** in Codex `rust-v0.171.0`, `config/src/mcp_types.rs`). T3 Code itself pre-approves a list of exact `mcp__t3-code__…` names for Claude Code in read-only sandboxes (**Read** at `59651c1`, `ClaudeAdapterV2.ts`). With `j3`, on `0.1.11` with Claude Code 2.1.330 and Codex 0.171.0, a tool named that way ran without asking in Supervised and any other `j3` tool asked (**Verified**, [Engine](../architecture/engine.md#behaviors-j3-bots-designs-around)).

## Decision

**A bot's connector tools are tools of the `j3` server, listed per session, and only J3 Bots' own tools are pre-approved.**

- **One server, listed per session.** The bridge answers `tools/list` from the server for its session: J3 Bots' own tools, then the accepted tools of every connector the bot is granted. A change of grant, or of a connector's accepted tools or status, makes the bridge send `notifications/tools/list_changed`. A tool taken from a bot drops out of its list the same way, and the server refuses a call to it at once. No harness configuration names a connector, so connecting one restarts nothing.
- **Names in the `j3` namespace.** A connector tool is `<connector>__<tool>` inside `j3`, which the harness shows as `mcp__j3__<connector>__<tool>`. The server keeps every name within the shorter harness limit, Claude Code's 64 characters with `[a-zA-Z0-9_-]` (**Read** in the Claude Code 2.1.328 bundle), shortening a long one with a stable hash, so a tool keeps its name across sessions.
- **Every call is matched to the bot's turn**, as J3 Bots' own tools are, with no weaker path: a call that matches no open call of the session's running turn is refused, and the grant is checked for the session's bot on that call.
- **Pre-approval narrows to J3 Bots' own names.** Claude Code is given the exact list of J3 Bots' own tool names in place of `mcp__j3__*`; Codex keeps the `j3` server, drops its default approval mode and approves each of J3 Bots' own tools by name. A connector tool then falls under the bot's permission mode like any other harness tool: an approval card in Supervised, the provider's reviewer in Auto, and a run in Full access. The base prompt's rules on acting for the operator still hold in every mode.
- **Calls that take time.** A connector call has a deadline of its own at the bridge, eleven minutes, far longer than the 30 seconds of J3 Bots' own tools and past the connector client's deadline, and each harness's tool timeout for `j3` is set a minute above it. Progress is not relayed: neither harness extends its timeout for it. A call the harness gives up on is cancelled to the bridge, which abandons it at the server and, from there, at the connector.
- **Results are data.** The server frames each result's text as untrusted content from that connector, as it frames anything else a bot reads, so a result can neither close the frame nor pass for J3 Bots or the operator.
- **One upstream session per connector and bot.** A connector's server may keep state per session, such as a cursor, which must not pass from one bot to another.

Each harness was run against what this needs before the bridge was built on it, on engine `0.1.11` with Claude Code 2.1.330 and Codex 0.171.0 (**Verified**, [Engine](../architecture/engine.md#behaviors-j3-bots-designs-around)): exact-name pre-approval holds on both, both list again mid-session, the engine's events name a connector tool as they name J3 Bots' own, and progress keeps no call alive, which is why long calls are handled as above. Not run: a harness signed in with a subscription rather than a provider connection, whose tool list Claude Code may defer differently.

## What it costs

- The connector tools' behaviour rests on harness features J3 Bots does not control. Codex lists a server's tools again mid-session only behind a feature still marked in development (**Read** in Codex `rust-v0.171.0`, `features/src/lib.rs`, `mcp_tool_list_changed`), which J3 Bots turns on: with it, Codex lists again at once and the model can call a new tool in the same turn; without it, not even at the next turn. Claude Code lists again at once, but offers a new tool to the model from the bot's next turn (**Verified** on `0.1.11` with Claude Code 2.1.330 and Codex 0.171.0).
- The harness shows one server, `j3`, for every connector, so its own status of a server says nothing about a single connector; J3 Bots' clients show that instead.
- Every model call can carry the bot's connector tools. On `0.1.11`, a Claude Code 2.1.330 bot on a provider connection sends every tool in each request, none deferred: 60 connector tools of about 800 bytes each add about 49 KB to the tool definitions (**Verified**), some 12,000 tokens at an **Assumed** four bytes a token. Codex 0.171.0 defers MCP tools, so its requests do not grow with them (**Verified**). How a subscription's sign-in changes Claude Code's deferral is not measured.
- J3 Bots' list of its own tool names is now part of the provisioning, and must change with every tool it adds.

## What was rejected

- **An entry per connector in the harness's configuration, pointing at the server over HTTP.** Codex cannot tell an HTTP server which session calls it, so the server could not tell which bot is calling; a credential per bot would mean configuration files the bot can edit. The configuration is also written only while the engine is stopped.
- **A second stdio server for connectors.** The same identity and matching, for a second process per loaded session, about 50 MB each.
- **Keeping the namespace pre-approved.** A connector's sends and deletions would run without asking even in Supervised.
- **An approval of J3 Bots' own for each connector call.** The harnesses already have one, which the permission mode governs and the clients already show.
