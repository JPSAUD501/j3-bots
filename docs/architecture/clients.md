# Clients

J3 Bots has three clients: a web app, a desktop app and a mobile app. All three show the same conversations and none of them runs a bot. A bot keeps working with every client closed.

## What clients share

**`packages/contracts`** defines every request, subscription, entity and error that crosses the wire. Clients and the server decode with the same schemas.

**`packages/client-runtime`** holds everything a client does that is not drawing:

- the connection: pairing, authentication, reconnect with backoff, resuming the subscriptions that resume and re-reading the ones that start with a snapshot;
- state: the roster, the open conversation, pending cards, routines, engine status;
- commands: sending a message, answering a card, stopping a bot, each with its own idempotency key and optimistic entry;
- drafts and unsent messages.

**`packages/design-tokens`** holds colors, type sizes, spacing, radii and motion timings as data, so the web stylesheet and the mobile theme are generated from one source.

The rule from T3 Code that J3 Bots adopts as is: **the UI stays dumb.** A component receives state and emits intent. If two clients need the same decision, the decision lives in `client-runtime`.

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

1. The operator runs `j3 pair` on the host, or opens Devices in an already paired client. Either shows a code and a QR code that expire in five minutes. The code is ten characters of Crockford base32 (no `I`, `L`, `O` or `U`); clients accept it in lower case and with spaces or dashes.
2. The new client sends the code to `POST /api/pair` and receives a device token. The server stores only a hash. A code works once.
3. Devices are listed in settings with their last activity, and can be revoked. Revoking closes that device's connections immediately.

A device token grants everything the operator can do in J3 Bots. There are no narrower roles in the first versions.

## Connecting

Every connection is one device's. The client opens the socket at `/ws` with its token as an `Authorization: Bearer` header. A browser cannot set that header on a WebSocket, so the web client first trades the token for a single-use ticket at `POST /api/socket-ticket` and opens `/ws?ticket=…` within a minute. Either way the server checks the credential once, at the upgrade, and the socket is that device's until it closes.

A 401 at the upgrade means the device is not paired or was revoked: the client stops reconnecting and asks to pair again. A closed socket otherwise means reconnect. Files go over HTTP with the same bearer: `POST /attachments` before sending a message that carries them, and `GET /attachments/:id` to open one.

## Behavior every client must get right

- **Offline and reconnect.** A message typed while disconnected is kept and sent on reconnect, exactly once.
- **One conversation everywhere.** An entry sent or answered on one device appears on the others without a reload.
- **Cards resolve once.** Answering a question or an approval on any device resolves it on all.
- **State is the server's.** A client never infers "the bot is working" from its own timers. It shows what the server reports and marks its view as stale when disconnected.
- **Every action has a name.** A command's label, its shortcut hint, its menu entry and its accessible name describe the same action on the same object.
- **Languages from the first screen.** Interface text goes through the translation layer from day one, as whole sentences. English is the source language.
