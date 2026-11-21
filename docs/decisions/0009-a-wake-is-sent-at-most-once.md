# 0009: A wake is sent at most once, and uncertainty fails visibly

**Status:** Proposed

## Context

The engine applies a command id once and keeps its receipts for good, but its replies can be lost: steps after the commit can fail, commands can wait in the engine's startup queue after the client gave up, and a socket can drop mid-call ([Engine](../architecture/engine.md#connecting)). After a lost reply, the session's own state may make a first-send check fail: the dispatch may itself have started the turn that makes the session busy. An error reply that names no refusal proves nothing either way.

## Decision

A wake goes back to pending only when the engine certainly applied nothing: the first send of its dispatch was refused locally, before anything was sent (`SessionBusy`, `SessionNotFound`), or a Stop fenced the dispatch before it was ever sent.

Every other uncertainty is resolved by recovery, a separate call (`redispatch`) that sends the same key and skips every local check. A recovery that succeeds means accepted, with the disposition unknown; delivery comes from the events. A refusal counts only when the engine's reply names it. A recovery that gets no answer within its bound, before its session is retired or lost, or within a day fails the dispatch, and its wakes fail visibly and are never re-queued. The operator retries a failed message, or a member's failed room turn, as new wakes under a new key, and only into a room that is still active, to a bot still its member: a failed wake survives its room's archival. If the engine turns out to have applied a failed dispatch after all, it is shown delivered.

## Consequences

- J3 Bots never sends one wake into a session twice on its own; a message can be lost only visibly.
- A failed message may turn out delivered later, and a message the operator retried meanwhile then reached the bot twice, by the operator's choice.
- First sends and recoveries are two adapter calls with different failure types, so neither carries an error it cannot raise.
- The server needs one serial gate per session, so a recovery, a Stop and a held-queue resume never interleave ([Server](../architecture/server.md#one-gate-per-session)).

## Rejected

**Re-queue the wakes after any error.** Simpler, and nothing is lost. A lost reply to a dispatch the engine applied would deliver the same wakes twice, the second time possibly into another turn or a new session.

**Keep retrying until an answer comes.** No failures to show. A session that is gone, or an engine that keeps failing the same way, would hold the wakes forever with nothing visible.
