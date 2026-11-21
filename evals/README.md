# End-to-end evals

Evals that run the real J3 Bots server and engine against real models. They spend model allowance and take minutes, so they run on demand, never in `test` or CI. The one-turn prompt evals live in `packages/prompts/evals` ([Prompt architecture](../docs/prompts/architecture.md#evaluation)).

## The three-bot room

Checks M3's "done when" ([Roadmap](../docs/roadmap.md#m3-more-than-one-bot)): a three-bot room completes a multi-step task without a loop and without waking a bot that had nothing to do. Its deterministic counterpart, which runs in CI on the in-memory engine, is `apps/server/src/rooms/ThreeBotRoom.test.ts`.

Each run:

1. Starts the server from this checkout in a fresh `J3_HOME` inside a temporary folder, listening on `127.0.0.1` only.
2. Connects its providers with `j3-bots provider connect`, the key piped on standard input.
3. Pairs as a device with a code from `j3-bots pair`, and drives the server over the RPC socket as a client does.
4. Creates three Claude Code bots in `auto` permission mode: Hal, a team lead; Ana, a researcher; Bo, a writer. It waits until their first-run turns are over.
5. Creates a room of the three, hosted by Hal, with the default hop limit, and posts a task addressed to nobody: turn twelve pieces of fictional beta feedback into `release-notes.md`, with what is new and the three most requested features with their counts, and share the file in the room. The message says who does what: Ana counts, Bo writes, Hal checks. It mentions none of them, so the work reaches Ana and Bo only if the bots hand it on with `mention`.
6. Waits until nothing has been under way for 30 seconds (no wake waiting or in a turn, no turn running, no background work a turn left), or 20 minutes at most.
7. Scores the run from the server's database, then stops the server and deletes the run's home.

A run passes when all of these hold:

| Check                                                                                                             | Read from                                                        |
| ----------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| A bot shared `release-notes.md` in the room                                                                       | the room's bot attachments                                       |
| At most 6 bot turns for the room                                                                                  | turns whose audience is the room                                 |
| No turn by a bot that no room wake addressed (as mentioned, or as host of a message to nobody)                    | room turns and room wakes                                        |
| No `chain-stopped` notice                                                                                         | the room's notices                                               |
| No `say` in a room turn that no wake addressing its bot began (a turn that continues another counts as that turn) | `say` tool calls, their turns and the dispatches that began them |
| The room went quiet within the deadline                                                                           | the database, polled                                             |

The report also gives the order of turns and the highest hop count a room wake reached against the room's limit, which is how the default hop limit is checked.

### Running it

You need Claude Code installed, and an endpoint that speaks Anthropic's Messages API for it, as for `j3-bots provider connect` ([Running on a Pi](../docs/operations/running-on-a-pi.md#connect-the-providers)).

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

Runs never overlap, and nothing outside the temporary folder is written. The first run downloads the pinned engine; later runs start it from there with `J3_ENGINE_BINARY`. The report is a Markdown table, one row per run.
