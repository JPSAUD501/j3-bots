# 0002: One server sits between clients and the engine

**Status:** Accepted

## Context

J3 Bots' clients could connect to the engine directly for chat and to a small side service for bot features, or they could connect to one J3 Bots server that hides the engine completely.

Several things have to happen with no client open: routines, bot-to-bot messages, room routing, notifications. So an always-on J3 Bots process exists either way.

## Decision

Clients talk only to the J3 Bots server, in J3 Bots' own contract. The J3 Bots server is the only client of the engine, and one package inside it is the only code that knows the engine's protocol.

## Consequences

- Clients never see an engine identifier, type or concept. They can be built and tested without an engine.
- An engine protocol change touches one package. Clients and the rest of the server are unaffected.
- The server must relay the live stream of a turn and translate it. That is real work, and it is also where J3 Bots decides what an operator should see of a turn, which it would have to decide anyway.
- J3 Bots cannot reuse T3 Code's client components or its client runtime. J3 Bots' interface is different enough that this costs little.
- One connection, one authentication scheme and one place to enforce authorization.

## Rejected

**Clients on the engine's protocol, plus a side service.** Less relay code, but every client would carry the engine's client runtime, which pulls in most of T3 Code's monorepo, and every engine change would reach every client.
