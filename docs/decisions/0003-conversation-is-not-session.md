# 0003: Conversations belong to Roster, sessions to the engine

**Status:** Proposed

## Context

The obvious mapping is one bot, one engine thread, and the thread is the conversation. Reading the engine showed why that does not hold for a bot meant to live for months:

- provider sessions are unloaded after 30 idle minutes and Claude Code deletes its transcripts after 30 days;
- the cost of each dispatch grows with the number of runs in a thread;
- changing provider replaces the working context with a summary;
- a routine that runs inside the main thread blocks the bot and fills its context with housekeeping;
- a room has no engine object at all.

## Decision

Roster stores conversations and rooms itself, as its own data. An engine thread is a **session**: replaceable working context for the model. A bot has one main session and short-lived side sessions for routine runs. Roster may rotate the main session at any time and seeds the new one from memory and the recent conversation.

## Consequences

- The conversation survives model changes, session loss and engine upgrades.
- Roster needs a store, a history API and search of its own.
- What a bot says has to be captured explicitly, which leads to [0004](0004-speech-is-a-tool.md).
- The main session does not see what side sessions did, so Roster adds a catch-up note to the next wake.
- A rotated session loses detail the digest does not carry. Memory is what a bot is expected to rely on across rotations, which is the right dependency.

## Rejected

**The thread is the conversation.** Simpler, and it is what a prototype on stock T3 Code would do. It ties everything the operator values to an object the engine treats as disposable.
