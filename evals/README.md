# End-to-end evals

Evals that run the real J3 Bots server and engine against real models. They spend model allowance and take minutes, so they run on demand, never in `test` or CI. The one-turn prompt evals live in `packages/prompts/evals` ([Prompt architecture](../docs/prompts/architecture.md#evaluation)).

## The three-bot room

Checks M3's "done when" ([Roadmap](../docs/roadmap.md#m3-more-than-one-bot)): a three-bot room completes a multi-step task without a loop and without a bot that had nothing to do speaking. Its deterministic counterpart, which runs in CI on the in-memory engine, is `apps/server/src/rooms/ThreeBotRoom.test.ts`.

Each run:

1. Starts the server from this checkout in a fresh `J3_HOME` inside a temporary folder, listening on `127.0.0.1` only. A server already on the port is never taken for it: only one that started after the spawn counts, and the spawned server exiting first ends the run.
2. Connects its providers with `j3-bots provider connect`, the key piped on standard input.
3. Pairs as a device with a code from `j3-bots pair`, and drives the server over the RPC socket as a client does.
4. Creates four Claude Code bots in `auto` permission mode: Hal, a team lead; Ana, a researcher; Bo, a writer; and Cy, a designer, the bystander. It waits until their first-run turns are over.
5. Creates a room of the four, Hal first, and posts a task addressed to nobody: turn twelve pieces of fictional beta feedback into `release-notes.md`, with what is new and the three most requested features with their counts, and share the file in the room.
6. Waits until nothing has been under way for 30 seconds: no wake waiting or in a turn, no turn running, no background work a turn left.
7. Scores the run from the server's database and the shared file, then stops the server and deletes the run's home.

The task says who does what: Ana counts, Bo writes, Hal checks. It mentions none of them, so it wakes every member, and each must take its own part from it and from what the others say. A member hands work on by mentioning the one who acts next, which wakes only that member, or by naming nobody, which wakes every other member; either way every member reads the message. The task gives Cy no part, so Cy reads everything and should say nothing.

The feedback asks for CSV export four times, dark mode three, recurring transactions two and splitting a purchase once, so "the three most requested" has one right answer.

A run passes when all of these hold:

| Check                                                                                                                                                                                          | Read from                                                       |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| A bot shared `release-notes.md` in the room                                                                                                                                                    | the room's bot attachments                                      |
| Its "Most requested next" section puts CSV export, dark mode and recurring transactions each on a line with its count (4, 3 and 2, in digits or words), and does not list splitting a purchase | the last shared `release-notes.md`, downloaded as a client does |
| Cy has no message in the room                                                                                                                                                                  | the room's entries                                              |
| At most 12 bot turns for the room                                                                                                                                                              | turns whose audience is the room                                |
| No `chain-stopped` notice                                                                                                                                                                      | the room's notices                                              |

The task wakes every member, and the three messages it calls for (Ana's counts, Bo's file, Hal's check) wake the members they mention or, mentioning nobody, every other member. A member's waiting wakes share one turn, so a room that does not loop takes at most three turns per member: twelve. A member speaking with nothing to add is what Cy's messages check; the report also gives the order of turns. Who a message wakes is checked in CI, not here. The report also gives the highest round of bots answering each other the room reached: the three messages are rounds 1 to 3 when each answers the one before, so Hal's check is written in an envelope that says the conversation is closing (`ROOM_CLOSING_ROUND`), and past round 4 (`ROOM_QUIET_ROUND`) a bot's message wakes nobody and the room shows `chain-stopped`, which fails the run.

A run must be over within 30 minutes of its start, boot included. A run that fails before it can be scored reports why and the last 20 lines its server wrote. The server's log never holds the endpoint's key: the server does not log it and drops the engine's output.

### Running it

You need Claude Code installed, and an endpoint that speaks Anthropic's Messages API for it, as for `j3-bots provider connect` ([Installing J3 Bots](../docs/operations/install.md#connect-the-providers)).

```sh
J3_EVAL_BASE_URL=http://127.0.0.1:8317 J3_EVAL_API_KEY=… pnpm --filter @j3-bots/evals room
```

| Variable           | Meaning                                                                                                     | Default                                          |
| ------------------ | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| `J3_EVAL_BASE_URL` | The endpoint's base URL, as `provider connect --base-url` takes it                                          | required                                         |
| `J3_EVAL_API_KEY`  | The endpoint's key. It is only ever written to the provider connection of each run's home, which is deleted | required                                         |
| `J3_EVAL_RUNS`     | How many runs, one after another                                                                            | 5                                                |
| `J3_EVAL_PORT`     | The server's port; the engine and the bot tools take the next two                                           | 3861                                             |
| `J3_EVAL_MODEL`    | The Claude Code model id the bots run on                                                                    | the first model the engine lists for Claude Code |

Runs never overlap, and nothing outside the temporary folder is written. The first run downloads the engine `engine.json` pins; later runs start it from there with `J3_ENGINE_BINARY`. The report is a Markdown table, one row per run, and the eval exits non-zero when any run fails.

## Everyone reads

Checks that a room wakes whom the operator's message is for, that each member answers only when it is for it, and that the room goes quiet on its own ([Rooms](../docs/architecture/server.md#rooms)). Its deterministic counterparts, on the in-memory engine, are `apps/server/src/rooms/RoomRouting.test.ts` and `ThreeBotRoom.test.ts`.

Each run starts, connects and pairs as the room eval does, on one harness, then:

1. Saves the operator's name and creates four bots on the harness, in `auto` permission mode, in this member order: Cy, a developer; Ana, who keeps the shop's books; Bo, a designer; and Dee, in customer support. It waits until their first-run turns are over, and creates a room of the four.
2. Writes "Hi everyone!" to the room, mentioning nobody, which wakes every member, and waits until nothing has been under way for 30 seconds.
3. Writes "@Ana send only 'banana'; everyone else don't answer", mentioning Ana, which wakes only her, and waits again until the room is quiet.
4. Scores each message from the server's database: the members' messages after it, and the room's turns until it was quiet.

A run passes when all of these hold:

| Check                                                                                | Read from                        |
| ------------------------------------------------------------------------------------ | -------------------------------- |
| Someone answers the greeting                                                         | the room's entries               |
| At most 8 turns (two per member) after the greeting, until quiet                     | turns whose audience is the room |
| Ana answers the request once, with just the word, at most quoted or with a full stop | the room's entries               |
| Nobody but Ana says anything after the request                                       | the room's entries               |
| At most 4 turns after the request, until quiet                                       | turns whose audience is the room |
| No `chain-stopped` notice: the room never goes quiet by its limit                    | the room's notices               |

How many members greet back is shown, not scored: each may. Every member reads the greeting once, and may read the replies to it once more; a ninth turn means the members started answering each other. The request wakes Ana alone; her reply names nobody, so it wakes each other member once, and they have nothing to say to it: four turns. The report gives every message with its author.

A run must be over within 20 minutes of its start, boot included.

### Running it

As for the team eval, with the harness the four bots run on:

```sh
J3_EVAL_HARNESS=claude-code J3_EVAL_BASE_URL=http://127.0.0.1:8317 J3_EVAL_API_KEY=… pnpm --filter @j3-bots/evals reads
```

`J3_EVAL_RUNS` defaults to 10 and `J3_EVAL_PORT` to 3881; the other variables are the team eval's.

## A team on the operator's word

Checks that a bot builds a team when the operator asks for one ([Rooms](../docs/architecture/server.md#rooms)): the primary bot creates teammates with `create_bot`, starts a room of them and itself with `start_room`, posts a kickoff, and a member answers there. Its deterministic counterpart, on the scripted agent, is `apps/server/scripted/team.test.ts`.

Each run starts, connects and pairs as the room eval does, on one harness, then:

1. Saves the operator's name, so the primary bot's hello asks for nothing, and creates the primary bot, Lia, in `auto` permission mode. It waits until her first-run turn is over.
2. Sends her, in Brazilian Portuguese, a request for a support group of several bots to help open the online shop of the operator's bakery. Who is in it, and what each does, is hers to decide.
3. Waits until a member other than Lia has a message in the room, or until nothing has been under way for 30 seconds.
4. Scores the run from the server's database, then stops the server and deletes the run's home.

Lia runs on the harness under test, and the bots she makes run on her model, so a Codex run tests a Codex team from the request to the members' answers. The report says which provider each made bot ran on: another one there means Lia's provider was not ready when she made it, and it took the default.

A run passes when all of these hold:

| Check                                       | Read from                   |
| ------------------------------------------- | --------------------------- |
| At least two bots made by `create_bot`      | Lia's tool calls            |
| A room with Lia its first member            | the rooms and their members |
| Every bot she made is a member of that room | the room's members          |
| A message of hers in the room: the kickoff  | the room's entries          |
| A message of another member in the room     | the room's entries          |

The report also gives, per run, the provider each made bot runs on, how the other members' room wakes ended and the tools they called there, the hellos the made bots wrote in their own conversations (a bot made for a room opens there, so these should be none), Lia's tool calls in order, and her last message to the operator.

A run must be over within 20 minutes of its start, boot included.

### Running it

You need the harness's command installed (`claude` or `codex`), and an endpoint for it, as for the room eval. `team` is also a pnpm command, so name the script with `run`:

```sh
J3_EVAL_HARNESS=codex J3_EVAL_BASE_URL=http://127.0.0.1:8317 J3_EVAL_API_KEY=… pnpm --filter @j3-bots/evals run team
```

| Variable           | Meaning                                                           | Default                                          |
| ------------------ | ----------------------------------------------------------------- | ------------------------------------------------ |
| `J3_EVAL_HARNESS`  | The harness Lia runs on: `claude-code` or `codex`                 | required                                         |
| `J3_EVAL_BASE_URL` | As for the room eval                                              | required                                         |
| `J3_EVAL_API_KEY`  | As for the room eval                                              | required                                         |
| `J3_EVAL_RUNS`     | How many runs, one after another                                  | 3                                                |
| `J3_EVAL_PORT`     | The server's port; the engine and the bot tools take the next two | 3871                                             |
| `J3_EVAL_MODEL`    | The model id Lia runs on                                          | the first model the engine lists for the harness |

Runs on different ports can go at once, one per harness.
