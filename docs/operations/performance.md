# Performance

What keeps J3 Bots fast and light, and the two budgets CI holds every change to. A change that loads more before a window shows anything, or sends a client more through a turn, fails its pull request until it either stops doing so or raises the budget and says why. The approach follows T3 Code's own regression budgets (`docs/internals/16_performance-regressions.md`, **Read** at `bc0f04d`). Why J3 Bots loads, sends and indexes as it does is in [decision 0105](../decisions/0105-the-web-client-loads-what-a-window-shows-and-ci-holds-it-to-a-budget.md).

## The web budget

What a browser loads before each window of the web client can show anything, in gzipped bytes, as the server sends it. A window's first load is its page, its route's code, every chunk and stylesheet those import statically, and the catalog of one language: the larger one, Brazilian Portuguese, stands for either.

| Window | What it is |
| --- | --- |
| `app` | The app: the roster, a conversation, a room |
| `quick` | Quick access, the desktop app's small window |
| `record` | The desktop app's screen recorder |

The budgets live in `apps/web/bundle-budget.json`. CI's **Web budget** step builds the client and checks them:

```sh
pnpm web-budget             # build, report each window, and fail over budget
pnpm web-budget --update    # build, report, and write new budgets
```

The report lists each window's first load raw and gzipped against its budget, and the code loaded later, on demand. `--update` writes each budget as what it measured plus 2 %, rounded up to a KiB, so a small change passes and a new dependency does not.

**Over budget.** First ask whether the window needs the new code before it shows anything. A dialog, a page of Settings, a viewer or anything else opened from the app once it is up is a `deferred` component (`apps/web/src/lib/deferred.tsx`), which keeps it out of the first load. If the window does need it, run `--update` and say in the pull request what grew and why.

## The wire budget

What the RPC socket sends a client, in bytes of JSON as the socket writes them, as it connects to a home in long use and through one ordinary turn. The test that holds it is `apps/server/src/rpc/wireBudget.test.ts`, part of `vp run test`. It seeds:

- eight bots and two rooms;
- one conversation of about three thousand entries, the others short;
- sixty messages in a room.

It then opens every subscription a client opens and runs one turn: the operator's message, four work steps and the bot's reply.

| Budget | Measured when set |
| --- | --- |
| A conversation's first frame (its newest hundred entries): 55,000 B | 50,181 B |
| The roster's first frame: 10,000 B | 9,075 B |
| Everything every subscription sends through the turn: 20,500 B | 18,749 B |

It also fails when a subscription sends a frame that repeats the one before it, byte for byte: that is a change sent whole for nothing.

When it fails, its message lists every frame it measured, by subscription, with its size and what it carried. Look first for what is sent whole where a part changed, or sent when nothing did. If the growth is real, raise the budget in the test to about a tenth over the new measurement and say why in the pull request.

## The database

The server keeps no planner statistics, so every read that runs on each change needs an index that answers it as written ([Server: data](../architecture/server.md#data)). To check a new query on a database of long use:

1. Seed a copy of a migrated database.
2. Run `EXPLAIN QUERY PLAN` on the statement exactly as the code sends it.
3. Confirm the plan has no `SCAN` of a table that grows with use: entries, changes, wakes, dispatches, turns, work steps.

A partial index serves a query only when the query's filter implies the index's, so a `json_extract` in a query and in its index must read the same.

An index for a foreign key's child column keeps a cascading delete from scanning that table once per row it removes. Add one with any new reference to `entries`, `dispatches`, `wakes` or `turns`.

## What was measured

The figures behind the budgets, before and after the changes of decision 0105 on the same code. Web sizes are from the production build. The server figures are from its bundled build on an x86 desktop, with a stand-in engine and no client connected.

**First load, by window** (gzip; raw in parentheses):

| Window | Before | After |
| --- | --- | --- |
| `app` | 768.6 KiB (2,462.9 KiB) | 650.8 KiB (2,022.9 KiB) |
| `quick` | 602.1 KiB (1,924.1 KiB) | 574.9 KiB (1,785.6 KiB) |
| `record` | 365.7 KiB (1,202.5 KiB) | 330.5 KiB (1,062.1 KiB) |

Before, the server sent these files uncompressed, so their raw size is what crossed the network. The budgets were set after the bot card and the other work of 0.15.0 had landed: 662.8 KiB, 586.5 KiB and 332.2 KiB gzip.

**One turn on the socket.** 28,663 B before, when 9 of the roster's 21 frames repeated the frame before them. 18,749 B after.

**Deleting a busy bot**, in a database of long use (ten bots, 32 thousand entries, 30 thousand wakes, dispatches and turns), took 94 s before and under a second after. The reads the roster and the turn machinery make on each change went from 3–24 ms each to under 0.1 ms.

**The server**, idle a minute and a half after it starts:

| Release | Resident memory | Start, until it answers |
| --- | --- | --- |
| 0.13.0 | 157 MB | 0.80–0.87 s |
| 0.14.0 | 161 MB | 0.84–1.21 s |
| With these changes | 163 MB | 0.83–1.02 s |

The start is the time from launching the process to the first answer on an existing home, over five starts each. Neither figure counts the engine, which runs as its own process.
