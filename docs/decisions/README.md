# Decision records

A record exists for a decision that would be expensive to reverse. Each one states the context, the decision, what it costs, and what was rejected.

**Accepted** records are settled. **Proposed** records are recommendations waiting for the project owner.

| # | Decision | Status |
| --- | --- | --- |
| [0001](0001-t3-code-as-unmodified-engine.md) | T3 Code is the engine, used unmodified | Accepted |
| [0002](0002-single-server-between-clients-and-engine.md) | One server sits between clients and the engine | Accepted |
| [0003](0003-conversation-is-not-session.md) | Conversations belong to J3 Bots, sessions to the engine | Proposed |
| [0004](0004-speech-is-a-tool.md) | Speech is a tool | Proposed |
| [0005](0005-j3-bots-owns-wakes.md) | J3 Bots owns scheduling and routing | Proposed |
| [0006](0006-memory-is-files.md) | Memory is files | Proposed |
| [0007](0007-client-and-server-stack.md) | Client and server stack | Accepted |
| [0008](0008-license.md) | License: AGPL-3.0-or-later | Accepted |
| [0009](0009-a-wake-is-sent-at-most-once.md) | A wake is sent at most once, and uncertainty fails visibly | Proposed |
| [0010](0010-workers-reconcile-durable-state.md) | The turn machinery's workers reconcile durable state | Proposed |

When a decision is replaced, its record is rewritten to say what now holds and why the earlier choice was dropped.
