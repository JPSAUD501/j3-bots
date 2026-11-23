# Architecture overview

## The pieces

```
  phone (Expo)      desktop (Electron)      browser
        \                  |                  /
         \                 |                 /
          +---- J3 Bots contract (WebSocket RPC) ----+
                           |
                 +---------v----------+
                 |   J3 Bots server    |   one process, always on
                 |                    |
                 |  bots, conversations, rooms, memory,
                 |  routines, wake queue, notifications
                 |                    |
                 |   engine adapter   |   the only code that knows T3 Code
                 +----+----------+----+
                      |          ^
      T3 client RPC   |          |  bot tools (MCP)
      over loopback   v          |
                 +---------------+----+
                 |   T3 Code server   |   unmodified, pinned version,
                 |    ("the engine")  |   own data directory, loopback only
                 +---------+----------+
                           |
              Claude Code, Codex, other harnesses
              running on the operator's subscriptions
```

There are three programs and two contracts.

**The engine** is a stock T3 Code server. J3 Bots starts it with its own data directory and port, bound to loopback. It owns model processes, subscription sign-ins, tool execution, approvals and the durability of each thread. Nobody connects to it except the J3 Bots server.

**The J3 Bots server** is one long-running Node process. It owns everything the operator thinks of as the product: bots, conversations, rooms, memory, routines, and the decision of which bot wakes for which event. It connects to the engine as a headless client, and it serves the clients.

**The clients** are a web app, an Electron shell around that web app, and an Expo mobile app. They render state and send intents. They hold no authority and never talk to the engine.

**The J3 Bots contract** is the schema-defined RPC between clients and the J3 Bots server. It speaks in product terms only: bots, conversations, messages, cards, routines.

**The engine contract** is T3 Code's own client protocol. Exactly one package in J3 Bots implements against it.

## The rule that shapes everything: a conversation is not a session

The operator sees a **conversation**. The model sees a **session**, which is an engine thread. J3 Bots keeps them separate on purpose.

The conversation is J3 Bots' data: every message a bot delivered and every message the operator sent, in order, forever. A session is working context: the engine thread a bot is currently thinking in.

Keeping them apart is what lets J3 Bots:

- change a bot's model or provider without losing the conversation;
- replace a session that has grown slow or whose provider transcript has expired, without the operator noticing;
- run a routine in a separate, fresh session and still have its result appear in the bot's conversation;
- give a room its own history while each member bot keeps a single working context;
- upgrade or even rebuild the engine's database without losing what was said.

A consequence: **what a bot says is an explicit act.** Bots deliver messages by calling a tool, and only what passes through that tool enters a conversation. The raw output of an engine thread is working material. This is what makes short replies, several messages per turn, and deliberate silence possible. See [decision 0004](../decisions/0004-speech-is-a-tool.md).

## How one message travels

The operator sends "what changed in the repo since Friday?" to a bot named Scout.

1. The client calls `message.send` on the J3 Bots server.
2. The server appends the operator's message to Scout's conversation and creates a **wake** of kind `user`, in one database transaction.
3. The wake dispatcher wraps the message in a wake envelope, records the dispatch, and sends it to Scout's main session through the engine adapter. If Scout is mid-turn on something the operator asked in this conversation, the dispatch steers that turn. If Scout is idle, it starts one. Otherwise the wake waits in the server, first in line, until Scout is free.
4. The engine runs the turn. Its events stream back to the adapter, which translates them into J3 Bots terms: Scout is thinking, Scout is running a command, Scout is waiting on an approval.
5. Scout calls the `say` tool: "Checking now." The tool call lands on the J3 Bots server, which appends the message to the conversation and pushes it to every connected client.
6. Scout works, then calls `say` again with the answer and marks its delivery done.
7. The server records the turn's outcome on the dispatch and, if no client was looking at that conversation, sends a notification.

A routine, a message from another bot and a room turn follow the same path from step 2. Only the kind of wake and the envelope differ.

## Boundaries and who may cross them

| Boundary | Rule |
| --- | --- |
| Client ↔ J3 Bots server | Only the J3 Bots contract. Clients never see an engine identifier. |
| J3 Bots server ↔ engine | Only through `packages/engine-t3`. No other package imports T3 Code types, knows its paths or parses its files. |
| Bot ↔ J3 Bots server | Only through J3 Bots' bot tools. A bot cannot read another bot's conversation or memory through them. |
| Bot ↔ host machine | Whatever the engine's permission mode allows. J3 Bots adds no sandbox of its own. |
| J3 Bots ↔ network | Loopback for the engine. The J3 Bots server listens where the operator configures it. Nothing leaves the machine except model traffic the harness makes and optional push notifications. |

## Repository layout (planned)

```
apps/
  server/      the J3 Bots server
  web/         the web client; also the desktop app's content
  desktop/     Electron shell
  mobile/      Expo app
packages/
  contracts/        J3 Bots contract: schemas for RPC, entities, errors
  engine-t3/        engine adapter: the only T3-aware code
  client-runtime/   connection, state and commands shared by all clients
  prompts/          base prompt, wake envelopes, tool descriptions, with their tests
  design-tokens/    colors, type, spacing, motion, bot palette, avatar shapes as data;
                    /raster draws avatars as PNG
  i18n/             interface sentences in every language, notification wording
docs/
```

## Why this shape

Each of these is argued in its own record:

- [0001: T3 Code is the engine, used unmodified](../decisions/0001-t3-code-as-unmodified-engine.md)
- [0002: One server sits between clients and the engine](../decisions/0002-single-server-between-clients-and-engine.md)
- [0003: Conversations belong to J3 Bots, sessions to the engine](../decisions/0003-conversation-is-not-session.md)
- [0004: Speech is a tool](../decisions/0004-speech-is-a-tool.md)
- [0005: J3 Bots owns scheduling and routing](../decisions/0005-j3-bots-owns-wakes.md)
- [0006: Memory is files](../decisions/0006-memory-is-files.md)
