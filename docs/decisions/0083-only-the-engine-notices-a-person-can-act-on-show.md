# 0083: Only the engine notices a person can act on show

**Status:** Accepted.

## Context

The engine tells a thread what it wants its reader to know as `system_notice` items: a line in its own words, with a level (`info`, `warning` or `error`) and, for some, the provider's own id of the situation. T3 Code's own client shows each in its timeline. Until 0.12.0, J3 Bots dropped every one, and logged none.

T3 Code 0.1.13 records a notice in these situations (**Read** at `bc0f04d`):

- Claude Code is not in Auto mode in a turn that asked for it (`ClaudeAdapterV2.ts`, `announceAutoFallback`), or could not confirm that it may skip asking in a turn that asked for Full access (the bypass downgrade at the turn's start). Either way it asks before acting.
- Claude Code hit a usage limit during a turn. The turn then fails at the limit.
- Stop reached a steer before the AI read it (`Orchestrator.ts`, and Claude Code's adapter).
- An MCP server needs a sign-in (Claude Code) or failed to start (Codex).
- Claude Code's own warnings and its blocking hook notices, and a hook that stopped a Codex turn (`RunExecutionService.ts`).
- The engine restarted or shut down under a turn (`ProviderRuntimeRecoveryService.ts`).
- A worktree branch was not renamed, a native fork fell back to a fresh session, a session was imported with part of its history (`ThreadLaunchService.ts`, `ProviderTurnStartService.ts`, `AgentSessionImporter.ts`).
- An ACP or Pi agent said something of its own.

Two more things in a thread read like notices, and are not: a compaction (`compaction` items) and the work a session does after its turn ends (`notification` items).

The audience is mostly not technical. A line about a branch, a fork or a hook means nothing to them, and a line about something J3 Bots already shows says it twice.

## Decision

**A notice shows only when it asks something of the operator, or explains what would otherwise confuse them. Every notice goes to the server's log.**

| Notice | Shown | Why |
| --- | --- | --- |
| Claude Code asks before acting, in Auto or Full access | Yes, as `asks-before-acting` | Approval cards appear that the operator chose not to get. Only this says why, and what to do. |
| Usage limit | No | The turn fails at the limit, and its notice says when it resets. |
| Steer not read before Stop | No | The message's own state says it was not delivered. |
| MCP server needs a sign-in or failed to start | No | The only server J3 Bots gives a harness is its own `j3` bridge, which needs none. A connector the bot cannot reach says so in its work. |
| Claude Code warnings, blocking hooks, a Codex hook's stop | No | Free text no one can put in plain words. A turn that ended without its reply already has its own notice. |
| The engine restarted under a turn | No | The turn's end, and J3 Bots' own redelivery, say it. |
| Branch rename, native fork, imported session | No | J3 Bots uses none of them. |
| An ACP or Pi agent's notice | No | The agent's own free text. |
| Compaction | No | The owner's choice: the bot keeps its magic. |
| Work after a turn | No | The owner's choice, as for compaction. |

- **The adapter decides, from the provider's own id.** Only `packages/engine-t3` reads a notice. It maps Claude Code's `auto-mode-unavailable:` and `bypass-policy-downgrade:` to `asks-before-acting` with the permission mode the turn asked for, and reports it as an `engine-notice` session event, which a replacement lists again while its turn runs (`notices`). The id is what T3 Code's own client reads to tell its notices apart: the text is for people, and changes.
- **It shows once, where the approvals are.** The server writes the notice in the bot's own conversation, also for a room turn, once per kind for each model the bot has (`engine_notices`). The engine says it again in every session: a routine runs each attempt in a new side session, and the bot's main session is replaced after many turns. A notice of a permission mode the bot no longer has is over, and does not show.
- **It says what to do.** For Auto: Auto isn't available to its AI here, with this account or model; answer the questions, or choose another model or permission mode. For Full access: its AI isn't allowed to skip asking on the computer running J3 Bots; answer the questions, or ask whoever manages the AI's settings there. The engine's words, redacted and scrubbed as a failure's are (decision 0072), are behind **Details**.
- **Everything is logged once.** The adapter logs each notice when its stream first records it, at the notice's level, with the session, the turn and the provider: its title, or its message when it has none, redacted and scrubbed. A message beside a title stays out of the log, since it can quote the operator: a steer Stop reached unread quotes the steer.

## Costs

- **A new notice kind.** Protocol 11 stays: an older client shows a notice of an unknown kind as its one line that asks for an update.
- **A notice recorded while no stream was open can be missed.** The adapter logs what a stream records as it happens, so one that arrives only within a replacement leaves no log line. A replacement lists only the notices of the turns still running, so one of a turn that started and ended while the server was not following is not shown either: the engine may not say it again until it restarts.
- **The log keeps a notice's title, not its message.** An MCP server's start-up error and a hook's reason are in the message, so the log names the situation without them.
- **The provider's id is not a contract.** If T3 Code renames it, the notice stops showing, and still goes to the log. The engine conformance suite cannot prompt it: no scripted provider runs Claude Code's permission modes. That it fires against a real Claude Code is **Assumed**.
- **Once per model can be too few.** An operator who moves a bot from Full access to Auto and back, on the same model, is not told again about Full access.

## Rejected

- **Showing every notice with its text.** Accurate, and mostly unreadable. It would also show what J3 Bots already says another way.
- **Showing notices by level.** A `warning` can be a hook's free text or a sign-in for a server J3 Bots never set up. The level says how much the engine cares, not whether the operator can act.
- **Telling the notice at the first approval it explains.** It would be closer to the card, but a turn that asks nothing would leave the operator unaware until it did, and the server would have to hold a notice per session. The notice comes when the engine says it, which is at the turn's start.
