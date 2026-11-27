# 0105: The web client loads what a window shows, and CI holds it to a budget

**Status:** Accepted.

## Context

The owner asked for careful optimization work that makes J3 Bots faster and lighter. Measured on 0.14.0, before anything changed:

- **The web client was one load.** Every window downloaded 2.5 MB of script and style before it showed anything: the app, quick access and the screen recorder. That included both language catalogs and every dialog. The server sent the files uncompressed.
- **The roster resent what a client had.** Every engine event of a turn signals the bot. The roster rebuilt the bot's item and sent it whole on each signal, so 9 of its 21 frames in one ordinary turn repeated the item before them.
- **Hot reads scanned tables.** Many reads the roster and the turn machinery make on every change scanned a whole table: entries, wakes, dispatches, turns, changes. Deleting a busy bot took over a minute, because its cascades scanned a table once for each row they removed.
- **Nothing measured any of this.** No check would have noticed it getting worse.

What was open:

- what a window loads first;
- whether the server compresses the web client, the socket, or both;
- how much of the roster's traffic to cut, and how;
- which indexes to add;
- how to keep all of it from regressing.

## Decision

**A window loads its route, the shell, the timeline and one language. Everything else loads when it opens. The server compresses the web client's files and not the socket. The roster sends an item only when it changed. Every hot read has an index. CI holds the first load and a turn's traffic to a budget.**

### What a window loads

- **The first load** is the window's route chunk, the shell, the timeline, the details and the browser beside a conversation, and the catalog of the operator's language. The shell moves focus into the details and the browser, and hands them Escape, in the same render that opens them, so they cannot arrive later. Only that language's catalog is fetched (`loadI18n`). A change of language keeps the old words on screen until the new catalog arrives.
- **Deferred components.** What most sessions never open is a `deferred` component (`apps/web/src/lib/deferred.tsx`). Its code is fetched the first time it is wanted, and it renders nothing until then. Once fetched, it renders at once.
  - This covers Settings' pages, the first run, the document viewer, the screen recording sheet, and the dialogs for bots, memory, connectors, rooms, routine runs and templates.
  - A dialog the app keeps mounted while closed fetches nothing until it first opens, then stays mounted, so it closes as it opens.
  - Settings' pages are fetched in the background once the page is idle, because they are what the operator opens most.
- **What stays in the first load**:
  - what a window shows as it opens: the onboarding check, pairing, the local desktop's first screen, the update prompt;
  - dictation, a hook of the composer;
  - a connector's app block, a few kilobytes whose late arrival would shift the timeline as it draws.
- **Results:**
  - The app's first load went from 782.7 KiB to 680.5 KiB gzipped, quick access from 614.2 KiB to 586.9 KiB, and the screen recorder from 368.0 KiB to 332.2 KiB.
  - Over the network that is 2,504.4 KiB before, uncompressed, against 680.5 KiB after.
  - The app now fetches about thirty files where it fetched nine. Over HTTP/1.1 on a slow link that costs some latency. Grouping chunks by hand was tried and dropped: the bundler then merged the catalogs back into shared chunks, or grew the recorder's load.

### Compression

- **The web client's files** are sent in Brotli or gzip, as the browser asks. A response compressed this way carries `Vary: Accept-Encoding` and a weak validator, and a `304` still answers it. Nothing in those files is secret, so compression reveals nothing.
- **The RPC socket is not compressed.**
  - A turn sends about 19 KB, which compression would hardly change on any network that runs J3 Bots.
  - `permessage-deflate` keeps about 300 KiB of compression state per socket.
  - The media and voice sockets share the server's one WebSocket server, so they would be compressed too. Their pictures and audio do not compress, and the work would add latency to the bot's browser view, on small boards most of all.

### The roster

- Each subscriber keeps every item as it last sent it, and sends one only when it differs.
- A change that leaves every item as it was sends no frame.
- One ordinary turn went from 28,663 B to 18,749 B on the socket, and the roster's share from 21 frames to 12.

### Indexes

Migration 0067:

- **Partial indexes for each hot read.** These are a session's dispatches in any state, the dispatches not sent yet, a bot's continuation and its opening wake, the open `ask` cards, a connector's requests for input, the turns whose little ones still work, and a room's live turns.
- **An index on every foreign key a cascade looks up.**
- **Results:**
  - Each such read went from 3–24 ms to under 0.1 ms on a database of long use.
  - Deleting a busy bot went from 94 s to under a second.
  - Writes cost the same, within noise.
- **Rewritten queries:**
  - The changes' bounds read each end of the key on their own.
  - The open `ask` cards are read before the entries.
  - A room's open dispatches are written with the filter of their index.

### Budgets

- **The web budget.** `pnpm web-budget`, run in CI, fails a pull request that grows a window's first load past `apps/web/bundle-budget.json`.
- **The wire budget.** `apps/server/src/rpc/wireBudget.test.ts` fails one that sends past the wire budget on connect or through a turn, or that sends a frame repeating the one before it.
- How to read and raise them is in [Performance](../operations/performance.md).

## Costs

- **Deferred components, first open.** A deferred component opens a moment later the first time on a slow network. This applies to the ones not fetched ahead.
- **Stale chunks.** A page left open across an upgrade asks for chunks a newer build replaced. It reloads once (`vite:preloadError`), and the service worker keeps every chunk of the build it serves.
- **The roster's memory.** The roster keeps one copy of each item per subscriber, a few kilobytes per bot.
- **Budgets need upkeep.** A change that needs more must raise a budget and say why, which is friction on purpose.

## Rejected

- **Compressing the socket.** See Compression above.
- **Planner statistics** (`ANALYZE`, `PRAGMA optimize` at start). Measured on the same database, they improved 27 plans and worsened 19, one read by three orders of magnitude. They would also be a snapshot that goes stale while the server runs. The read they fixed is fixed by its join order instead.
- **A slimmer roster frame** that sends only the fields that changed. It would need a new contract field and client support for little more once repeats are gone. It is left for a release that changes the roster's shape anyway.
- **Grouping chunks by hand.** See What a window loads above.
