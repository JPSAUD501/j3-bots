# 0047: J3 Bots is a complete MCP host at the current specification

**Status:** Accepted

## Context

Until 0.9.0 J3 Bots used a slice of MCP: a connector's tools, over the 2025-era session protocol, behind a review of its own ([decision 0026](0026-a-bot-uses-connected-services-through-j3-bots.md), [decision 0027](0027-connector-tools-reach-a-bot-through-the-j3-bridge.md)). A tool its server added later, or one whose description or input changed, was held from every bot until the operator accepted it. A server could offer resources, prompts, a question for the operator or a long task, and J3 Bots ignored them.

What changed:

- **The specification moved.** Revision 2026-07-28 makes the protocol stateless over HTTP, with `server/discover` in place of `initialize`, list caching (`ttlMs`), requests that need the operator's input answered by the client and retried (multi round-trip requests), the Tasks extension for work that outlasts a call, and authorization that prefers a client metadata document to dynamic registration. The official TypeScript SDK's client implements it at 2.4.0 (**Read** in its source at 2.4.0).
- **The review protected less than it looked.** It covered what bots are told a tool is, its name, description and input. A server could always change what a tool does behind the same listing, and the review held every changed tool from every bot until the operator looked, which a server that ships often turns into a standing chore.
- **The bots now manage servers themselves** ([decision 0049](0049-the-bots-manage-mcp-servers-and-skills.md)), under their permission mode. A review of J3 Bots' own on top would be a second gate that the harness's own already covers.

## Decision

**J3 Bots speaks MCP as a complete host at 2026-07-28, falls back to older servers, and takes a connector's tools as its server lists them, with no review of its own.**

- **The protocol.** The client probes with `server/discover` over HTTP and over a process's streams, and falls back to `initialize` for an older server, down to 2024-11-05. It declares elicitation, in forms and by URL, and Tasks; never sampling or roots. Lists are cached as their server says, and dropped when it says one changed.
- **Authorization.** Protected resource metadata, authorization server discovery, PKCE with S256 and resource indicators, as before. A sign-in uses J3 Bots' client metadata document, served at the server's public origin, when the authorization server takes one and the document can be read from the internet; otherwise it registers dynamically. A call refused for a scope asks for a sign-in with that scope (step-up).
- **Tools.** A connector's tools are those its server lists now, named `<connector>__<tool>`, cleaned as before, and reach bots as they change. The harness's permission mode is the gate: an approval in Supervised, the provider's reviewer in Auto. Each tool's `_meta.ui` is kept, and recorded on the call's work step, for MCP Apps.
- **Resources and prompts.** A bot lists, reads and searches a connector's resources and templates, and lists and gets its prompts, with four tools of J3 Bots' own, which frame what they return as untrusted data. The operator uses a connector's prompts from a `/` menu in a bot's conversation, which puts the prompt in their draft.
- **Questions for the operator.** A server's request for input becomes a card in the conversation of the bot whose call caused it, a form or a page to open, with Accept, Decline and Not now, and a notification. The answer goes to the server only. A form that asks for a secret is declined unseen.
- **Tasks, progress and logs.** A call answered with a task is followed until it ends, at most an hour, and cancelled when the bot's turn stops. Progress shows on the bot's work step, at most once a second. A server's log messages go to the server's log, bounded.
- **Every bot by default.** A connector the operator adds without naming bots goes to every bot, those made later included.
- **Tool search.** Claude Code runs with tool search on, so a connector's tools are found when a turn needs them rather than filling every request; J3 Bots' own tools ask to stay loaded.

## What it costs

- **A changed tool reaches bots unseen.** A server can change a tool's description or input and bots get it at once; the base prompt's rules, the framing of every description and the permission mode are what stand between that and an action.
- **More of what a server writes reaches a bot.** Resources and prompts are more untrusted text in its context, read only when the bot or the operator asks for them.
- **A question in the middle of a call holds the bot.** Its turn waits on the card until the operator answers, declines or the call ends.
- **The client metadata document needs a public origin.** A server reached only on the operator's network registers as before, and that a provider reads the document as the draft says is **Assumed**: the tests use a fake authorization server.
- **What is not handled yet.** A 2025-era server's `-32042` error (URL elicitation required) reaches the bot as the call's error instead of a card; a request for input from such a server over a process's streams, while several bots call it at once, is declined, since the call that asked cannot be told.

## What was rejected

- **Keeping the review.** It covered only what bots are told a tool is, and asked the operator for every change of every server, while the permission mode already asks for each call in Supervised.
- **Answering for the operator.** A server's question goes to the operator, never to the bot: the bot could be talked into an answer, and a form's values are the operator's data.
- **Sampling.** A server that samples a model through J3 Bots would spend the operator's allowance on text it writes; a bot's model is the bot's.
