# Clients

J3 Bots has three clients: a web app, a desktop app and a mobile app. All three show the same conversations and none of them runs a bot. A bot keeps working with every client closed.

## What clients share

**`packages/contracts`** defines every request, subscription, entity and error that crosses the wire. Clients and the server decode with the same schemas.

**`packages/client-runtime`** holds everything a client does that is not drawing:

- the connection: pairing, authentication, reconnect with backoff, resuming the subscriptions that resume and re-reading the ones that start with a snapshot;
- state: the roster, the open conversation, pending cards, routines, engine status;
- commands: sending a message, answering a card, stopping a bot, each with its own idempotency key and optimistic entry;
- drafts and unsent messages.

**`packages/design-tokens`** holds colors, the bot palette, the avatar shapes, type sizes, spacing, radii, motion timings and layout sizes as data, so the web stylesheet and the mobile theme are generated from one source. The web stylesheet is generated today; the mobile theme will be generated from the same data.

`client-runtime` imports nothing from a platform. Each app provides it, as services: the server's origin; a credential store (IndexedDB in the browser, the keychain or keystore on mobile, the OS vault on desktop); a small local store that keeps drafts and unsent messages across restarts; locks shared by the app's windows (the Web Locks API in a browser); a file uploader that reports progress; a source of network status; an HTTP client and a WebSocket constructor (`fetch` and the global `WebSocket` on all three); and a secure random source. The runtime exposes state as values a UI reads synchronously and watches with a listener, so any renderer can use it; React hooks over them live in `@j3-bots/client-runtime/react`.

The rule from T3 Code that J3 Bots adopts as is: **the UI stays dumb.** A component receives state and emits intent. If two clients need the same decision, the decision lives in `client-runtime`. The web client still keeps the decisions it has made so far (roster order, status lines, timeline grouping, schedules in words) in `apps/web/src/presentation` and `apps/web/src/lib`, free of React, so they can move there unchanged.

## Web

The reference client. It is served by the J3 Bots server itself, so pointing a browser at the server is enough to use J3 Bots.

- React with the React Compiler, TanStack Router, Tailwind CSS v4 with tokens as CSS variables.
- Component primitives on Base UI, in a local `components/ui` layer whose components own their look: callers pick a variant, they do not restyle.
- A virtualized conversation list that keeps the scroll position stable while messages stream in.
- Installable as a PWA, which gives phone users a working client before the native app exists.

## Desktop

An Electron shell around the web client.

- Loads the built web client from a privileged custom scheme, not from a dev server or a `file://` path.
- Adds what a browser tab cannot do: a global shortcut to open the composer, native notifications with actions, a menu-bar presence that shows which bots need the operator, deep links (`j3bots://bot/<id>`), auto-update.
- Connects to a J3 Bots server the operator points it at. Bundling a server and an engine inside the desktop app, for people who have no always-on machine, is a later step and not part of the first versions.

## Mobile

An Expo app for iOS and Android.

- React Native with React Navigation's native stack. The three regions (roster, conversation, details) are a stack on phones and columns on tablets.
- Uniwind for styling, fed by the same tokens as the web.
- LegendList for the conversation, with keyboard-aware scrolling.
- Push notifications, dictation in the composer, and the share sheet as a way to send something to a bot.

Mobile uses its own components. Web and mobile share logic, tokens and vocabulary, not React components. See [decision 0007](../decisions/0007-client-and-server-stack.md) for why, and for the alternative of a single universal codebase.

## Reaching the server

The server listens on an address the operator chooses. J3 Bots does not run a relay.

| Where the client is | How it reaches the server |
| --- | --- |
| Same machine | Loopback |
| Same network | The server's LAN address |
| Anywhere else | The operator's own private network (Tailscale, WireGuard) or their own reverse proxy with TLS |

Plain HTTP is accepted only on loopback and private address ranges. Everything else requires TLS.

## Pairing

A new client is paired with a one-time code.

1. The operator runs `j3-bots pair` on the host, which prints the code and the addresses the server listens on, or opens Devices in an already paired client, which shows the code as text with the time it expires. A code expires in five minutes. Making one in Devices needs a connection to the server; offline, Devices says so. A QR code that carries the address and the code is planned. The code is ten characters of Crockford base32 (no `I`, `L`, `O` or `U`); clients accept it in lower case and with spaces or dashes.
2. The new client sends the code to `POST /api/pair` and receives a device token. The server stores only a hash. A code works once.
3. Devices are listed in settings with their last activity, and can be revoked. Revoking closes that device's connections immediately. A client waits ten seconds at most for the server to confirm a revocation; without that answer it says the revocation is not confirmed, offers to try again, and reads the list again once connected, which shows whether the device is still there.

A device token grants everything the operator can do in J3 Bots. There are no narrower roles in the first versions.

Signing out a device ends its access. It is offered in settings and, while there is no roster yet (connecting, or before the first bot), as a quiet button on that screen. It takes four steps, each attempted whatever the others did, and each failure is logged on its own:

1. It stops sending the outbox.
2. If it is connected, it revokes its own credential on the server, waiting up to ten seconds for the answer.
3. It deletes its drafts and unsent messages, which hold conversation text.
4. It deletes the credential, and only then returns to pairing. If that deletion fails, the device stays signed in, and settings say that sign-out did not finish.

When the server cannot be reached, the device still signs out here, and the pairing screen says the other devices list it until one of them revokes it. A device keeps no conversation text without a credential: whenever it loses its credential (signed out, revoked, or signed out in another tab), its drafts and unsent messages are discarded. In a browser, every change to the stored credential is announced to the origin's other tabs with `BroadcastChannel`, and each loads it again, so pairing or signing out in one tab takes effect in all of them.

## Connecting

Every connection is one device's. The server accepts the device token as an `Authorization: Bearer` header on the upgrade, or a single-use ticket bought with it at `POST /api/socket-ticket` and passed as `/ws?ticket=…` within a minute. Either way the server checks the credential once, at the upgrade, and the socket is that device's until it closes.

All three clients use the ticket. A browser cannot set a header on a WebSocket, and cannot read the status of a refused upgrade, which reaches it as a plain connection failure. The ticket route is plain HTTP, whose status every platform reads the same way, so one path serves all three:

- Before its first ticket, the client checks `GET /api/server`. A server that speaks another protocol version is shown as incompatible and not retried until the operator asks.
- Every socket is opened with a fresh ticket, since a ticket works once.
- A 401 from the ticket route whose body is the server's own `NotAuthenticated` means the device is not paired or was revoked: the client forgets its credential, stops reconnecting and asks to pair again. Any other 401 comes from something in between, such as a reverse proxy whose own login expired, and counts as the server being out of reach: the client keeps its credential, drafts and unsent messages, and tries again.
- Anything else (no answer, a refused upgrade, a socket that closes after it opened) means try again, after a pause that doubles from half a second up to thirty seconds, jittered so clients do not return together. When the platform reports the network gone, the client closes its socket at once rather than wait for it to fail, which can take a long time; it then waits, and tries at once when the network returns.

A request in flight when its socket closes is sent again on the next socket. That is safe because every command carries its command id, and the rest are reads. Files go over HTTP with the same bearer: `POST /attachments` before sending a message that carries them, and `GET /attachments/:id` to open one. The ticket's rule holds for files too: only the server's own `NotAuthenticated` in a 401 means the device is not paired, and an answer that comes from another address, as when a proxy redirects the request to its own login page, did not come from the server. Either is a failure to try again, not a refusal.

No HTTP request waits forever, since a server or a proxy can take one and never answer. The server check, pairing and the ticket get ten seconds each, after which the server counts as out of reach and the pause above follows. A file transfer gets the same ten seconds plus time for its bytes over a slow link (32 KiB a second), fifteen minutes at most, counted until its last byte is read: an upload then starts again after the same pause, and a download says the file could not be opened. The installed web app's service worker sends a page load to the network first and opens the copy of the app it keeps when the network fails, when the server answers with an error of its own (a 5xx), or when the whole page, headers and body, has not arrived after four seconds. The page that loads is the network's answer itself, its headers, status and address untouched; the worker only reads a copy of it to the end. After the four seconds, a page still arriving is cancelled, and so is the body of one whose headers come later. A request with no answer yet is left to end on its own while the kept page shows: sent with an abort signal, it would no longer be a page load to the server or a proxy.

## Behavior every client must get right

- **Offline and reconnect.** A message typed while disconnected is kept and sent on reconnect, exactly once, and the messages of one conversation reach the server in the order they were written. Sending moves the message from its draft to the outbox in one storage transaction, so a crash leaves it in exactly one of them; if the device cannot keep it, it stays in the draft and the operator is told. A draft is kept whatever its length; the limits of a message apply when it is sent, checked against the same schemas and limits the server applies (its text, its number of files, an empty file, the size of each inline image and of all of them together), both where the composer sends a draft and where any message enters the outbox: a message over one is not sent, the draft stays as it is, and the composer says why. While that transaction runs, a few milliseconds, the composer is read-only and takes no files, so nothing typed meanwhile is lost.
- **Several windows.** Each draft is stored with a revision. Every write of it, as the operator types and when Send moves it to the outbox, claims the revision this window last read or wrote; if another window sent or changed the draft since, it writes nothing, and this window shows the draft as stored, with its own files still uploading or refused on top, as far as one message can carry them (a file still uploading that no longer fits stops, and says why), and tells the operator, saying it sent nothing when it was sending. A draft emptied or sent stays stored, empty, with a revision of its own, so a window that read it before still finds it changed; it reads as no draft, and there is at most one such record per conversation. One rule keeps this whole: every operation on a draft (autosave, deletion, Send, Restore) runs under this window's draft lock (one for all of its drafts) and reads its inputs, both the in-memory draft and the expected stored revision, only after acquiring the lock. Send commits exactly the text and files the operator pressed Send on, captured at the press, or nothing. Only what is persisted is ever written: upload progress and failed files live in memory only. The lock is the window's own; between windows, the revision decides. When this window held text the device never kept, the notice offers to restore it, which writes it as a new change over the stored draft: nothing is written back unless the operator asks. Text the device kept, the other window had in front of it, so there is nothing to restore. The offer, one text per draft, lasts until the operator restores it or sends the draft, through any later change: a change that displaces no new text keeps it, and its notice offers it again. A change that displaces new text replaces the offer only when nothing is lost, because the new text holds the offered one or the device keeps it; otherwise the offer keeps the older text, which the operator was already shown, and the newer one, typed over the draft the other window had in front of it, goes. Unsent messages follow one rule: the stored outbox records are the only truth about them. Every window's list of outgoing messages is a projection of storage, read again whenever another window changes the outbox, after each read a delivery makes, on every connection, and every five seconds while connected, which bounds how long a message waits when the window that kept it closed before telling the others. Delivery, Retry and Discard act on the stored record, claimed with the state the window expects in one storage transaction, so a window that missed a change does nothing rather than undo it. Every attempt to deliver a message has its own persisted revision. A claim (Retry, Discard, recording an answer) names the revision it expects. A caller waiting on an attempt is answered only from storage that reflects that attempt. The command id stays the same across attempts, so the server applies the message once. Recording the server's answer is part of the attempt: the window keeps the conversation's lock until the device holds the answer, trying a failed write again a few times within a fraction of a second, and never sends the attempt again meanwhile. When the device still cannot record it, the message says so, and the window records the answer at a later read instead of sending it again; another window, which does not have the answer, may send the same attempt, which the server answers from its receipt. An accepted message leaves the conversation when its entry arrives, or when a read of the conversation started after the window knew the server had it holds no such entry: the entry is then older than the history loaded, where scrolling back finds it. A delivered or discarded message leaves a record of its outcome for ten minutes, so a window still showing it can tell one from the other. A window's memory holds a message only when the device could not keep it. One window at a time sends a conversation's messages, holding a lock named for that conversation, and only while its connection lives: a window whose socket closes lets go of the lock, and a connected window sends what it was sending. The window that holds the lock sends everything the device keeps for the conversation in the order it was kept, given by a sequence number the outbox assigns in the transaction that keeps the message. A browser announces each change to the outbox to the origin's other tabs with `BroadcastChannel`. A page served over plain HTTP on a local network has no Web Locks API, so there each tab sends on its own: no message is recorded twice, but two tabs can interleave their messages to one conversation.
- **A message sent again after a reload** leaves the conversation once the server accepts it; its entry may be older than the history loaded, and shows where it belongs when the history is read.
- **One conversation everywhere.** An entry sent or answered on one device appears on the others without a reload.
- **Cards resolve once.** Answering a question or an approval on any device resolves it on all.
- **State is the server's.** A client never infers "the bot is working" from its own timers. It shows what the server reports and marks its view as stale when disconnected.
- **Every action has a name.** A command's label, its shortcut hint, its menu entry and its accessible name describe the same action on the same object.
- **Languages from the first screen.** Interface text goes through the translation layer from day one, as whole sentences. English is the source language.
