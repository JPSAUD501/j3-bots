# 0027: Connector tools reach a bot through the `j3` bridge, under the bot's permission mode

**Status:** Proposed

## Context

J3 Bots holds every connector's sign-in and calls the connector itself ([decision 0026](0026-a-bot-uses-connected-services-through-j3-bots.md)). A bot still has to see the connector's tools in its harness and call them, and the server has to know which bot is calling, on both harnesses, to check the connector's grant.

What the pieces allow:

- **Only a stdio MCP server learns which session calls it, on both harnesses.** The engine gives each harness process the session's thread id (`T3CODE_THREAD_ID`); on Codex, where one app-server serves many threads, it sets it per thread only in the shell's environment and in the environment of the stdio servers it starts (**Read** in T3 Code at `59651c1`, `CodexAdapterV2.ts` and `ClaudeAdapterV2.ts`). An HTTP server the harness calls is told nothing about the session.
- **J3 Bots already has such a server.** The `j3` bridge is a stdio process per loaded session that reads that id and forwards each call to the server, which matches the call to the engine's own record of it in the bot's running turn ([Server: bot tools](../architecture/server.md#bot-tools)). That match is what keeps a local process that knows a session's id from acting as that bot's turn.
- **The bridge's tools are pre-approved as a namespace.** Claude Code runs with `--allowedTools mcp__j3__*` and Codex with `default_tools_approval_mode = "approve"` on the `j3` server, so every `j3` tool runs without asking, in every permission mode ([Security: permission modes](../architecture/security.md#permission-modes)). That is right for J3 Bots' own tools, which only reach J3 Bots. It would be wrong for a connector's: sending an email or deleting a page should ask in Supervised as a shell command does.
- **Both harnesses can pre-approve exact names.** Codex takes an approval mode per tool of a server (**Read** in Codex `rust-v0.171.0`, `config/src/mcp_types.rs`). T3 Code itself pre-approves a list of exact `mcp__t3-code__…` names for Claude Code in read-only sandboxes (**Read** at `59651c1`, `ClaudeAdapterV2.ts`). That exact names behave the same for `j3` is **Assumed** until it is run against the pinned engine and harnesses.

## Decision

**A bot's connector tools are tools of the `j3` server, listed per session, and only J3 Bots' own tools are pre-approved.**

- **One server, listed per session.** The bridge answers `tools/list` from the server for its session: J3 Bots' own tools, then the accepted tools of every connector the bot is granted. A change of grant, or of a connector's accepted tools or status, makes the bridge send `notifications/tools/list_changed`. No harness configuration names a connector, so connecting one restarts nothing.
- **Names in the `j3` namespace.** A connector tool is `<connector>__<tool>` inside `j3`, which the harness shows as `mcp__j3__<connector>__<tool>`. The server keeps every name within the shorter harness limit, Claude Code's 64 characters with `[a-zA-Z0-9_-]` (**Read** in the Claude Code 2.1.328 bundle), shortening a long one with a stable hash, so a tool keeps its name across sessions.
- **Every call is matched to the bot's turn**, as J3 Bots' own tools are, with no weaker path: a call that matches no open call of the session's running turn is refused, and the grant is checked for the session's bot on that call.
- **Pre-approval narrows to J3 Bots' own names.** Claude Code is given the exact list of J3 Bots' own tool names in place of `mcp__j3__*`; Codex keeps the `j3` server, drops its default approval mode and approves each of J3 Bots' own tools by name. A connector tool then falls under the bot's permission mode like any other harness tool: an approval card in Supervised, the provider's reviewer in Auto, and a run in Full access. The base prompt's rules on acting for the operator still hold in every mode.
- **Calls that take time.** A connector call has a deadline of its own, far longer than the 30 seconds of J3 Bots' own tools, and the server relays the connector's progress to the bridge so the harness's own timer does not end a call that is still working; the harness's tool timeout for `j3` is raised to match.
- **Results are data.** The server frames each result's text as untrusted content from that connector, as it frames anything else a bot reads, so a result can neither close the frame nor pass for J3 Bots or the operator.
- **One upstream session per connector and bot.** A connector's server may keep state per session, such as a cursor, which must not pass from one bot to another.

Whether each harness behaves as this needs (exact-name pre-approval, re-listing mid-session, progress that keeps a call alive, the engine's events naming the tool) is run against the pinned engine and both harnesses before the bridge is built on it. A result that differs changes this record.

## What it costs

- The connector tools' approval behaviour rests on harness features J3 Bots does not control. Codex re-lists a server's tools mid-session only behind a feature still in development (**Read** in Codex `rust-v0.171.0`, `features/src/lib.rs`, `mcp_tool_list_changed`); without it a Codex bot gets a new connector from its next session.
- The harness shows one server, `j3`, for every connector, so its own status of a server says nothing about a single connector; J3 Bots' clients show that instead.
- Every model call carries the bot's connector tools. Many tools could double what a Claude Code call takes in unless the harness defers large tool lists for `j3` too, which is **Assumed**.
- J3 Bots' list of its own tool names is now part of the provisioning, and must change with every tool it adds.

## What was rejected

- **An entry per connector in the harness's configuration, pointing at the server over HTTP.** Codex cannot tell an HTTP server which session calls it, so the server could not tell which bot is calling; a credential per bot would mean configuration files the bot can edit. The configuration is also written only while the engine is stopped.
- **A second stdio server for connectors.** The same identity and matching, for a second process per loaded session, about 50 MB each.
- **Keeping the namespace pre-approved.** A connector's sends and deletions would run without asking even in Supervised.
- **An approval of J3 Bots' own for each connector call.** The harnesses already have one, which the permission mode governs and the clients already show.
