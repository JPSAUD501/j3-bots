# 0001: T3 Code is the engine, used unmodified

**Status:** Accepted

## Context

Running agent harnesses on a user's subscriptions is hard to do well: each provider has its own process model, session format, permission scheme and failure modes, and all of them change often. T3 Code already does this for Claude Code, Codex and several others, with durable threads, queueing, steering, approvals and usage-limit handling. It is MIT licensed and moves fast: its server, contracts and client runtime each saw more than a hundred commits in the thirty days before this was written.

Roster needs that capability and has no interest in rebuilding it.

## Decision

Roster runs a stock T3 Code server, pinned to one exact version, in its own data directory, and drives it through the WebSocket RPC that T3 Code's own clients use. Roster does not fork T3 Code and does not patch it.

## Why not a fork

A fork that carries Roster's features inside T3 Code's server would conflict with upstream weekly. T3 Code does not accept outside feature contributions, so the changes could never go back. Every engine improvement would arrive through a merge.

## Why not build on the provider SDKs directly

That is rebuilding T3 Code's adapters, session recovery and approval plumbing for each provider, and then maintaining them.

## Why the client RPC and not `/mcp`

`/mcp` is the documented way for outside agents to use T3 Code, but it is request and response only. A product that shows a bot working needs the live event stream, and needs to answer approvals, both of which only the client RPC provides. The client RPC is an internal contract; pinning the version is what makes depending on it acceptable.

## Consequences

- Upgrading the engine is a version bump plus a conformance run against the real server.
- Roster can only do what an unmodified T3 Code allows. Where T3 Code has no lever (for example, removing its own orchestration instructions from the prompt), Roster designs around it.
- If T3 Code changes its client protocol incompatibly, only the adapter package changes.
- Roster's supported providers are a subset of T3 Code's.

## Verified

An isolated instance started with its own data directory, and a plain Node process with no T3 Code dependency authenticated with a CLI-minted token, opened the client WebSocket and received the shell snapshot. See [research/t3-code.md](../research/t3-code.md).
