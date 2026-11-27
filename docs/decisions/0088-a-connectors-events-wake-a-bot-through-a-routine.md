# 0088: A connector's events wake a bot through a routine

**Status:** Accepted.

## Context

MCP's Events extension (`io.modelcontextprotocol/events`, Beta, SEP-3415) lets a server tell its client that something happened at the service: a new email, a changed calendar entry, an issue assigned. A server lists the events it offers (`events/list`), each with a description, the arguments it takes, the payload it sends and how it can deliver it: answers to `events/poll`, a stream the client holds open (`events/stream`), or a signed webhook it posts to an address the client gives (`events/subscribe`). Delivery carries a cursor to resume from, an id per event, a flag when events were lost, and a way for the server to end a subscription.

Before this, a bot could only check a service on a schedule, or ask the operator to point the service at a webhook routine's address. The owner asked that a bot connect and use a connector's events itself: the operator only asks for what they want to hear about.

The official MCP SDK J3 Bots pins (`@modelcontextprotocol/client` 2.4.0) has none of the extension yet.

## Decision

**A connector's event is a routine's trigger, set by a bot, held by the server.**

- **The bot sets it, as any trigger.** `list_connector_events` shows what each connector the bot may use offers; `set_routine` takes an `event` beside `schedule`, `at` and `webhook`: the connector, the event's name, the arguments it takes, and a `summary` in the operator's language. The operator never sees an address, a delivery mode or a subscription. The routine reads "When Mail says a new email from Ana arrives", pauses, opens its runs and is deleted like any routine.
- **Events wake nobody by themselves.** Only a routine asking for an event subscribes to it, through its own bot's session of the connector, so the connector's grant and sign-in are that bot's.
- **The server holds every subscription, never the bot.** It listens by webhook when it has a public `https:` origin, else by a stream it holds open, else by polling, and falls back to the next way when one fails. Where it stands is kept after each event, and a restart resumes there, no more than six hours back.
- **An event runs the routine, with the event as data.** Each event is taken once, by its id. Events that arrive while a run is going wait and start one run together, within the ten runs a minute a webhook routine has. The run's envelope carries each event's name, time and payload in a nonce block, as a webhook body is carried, and says when some may have been missed.
- **A stop is said, not hidden.** When the server ends the subscription or refuses it, or the connector is gone, the routine keeps its trigger and shows that it stopped and why, the conversation records it, and the bot is told at its next turn, to tell the operator and offer to set it again.
- **The extension lives in one module on the transport tap.** Its five methods and the stream's notifications are spoken beside the SDK, as Tasks' requests are, in `packages/connectors`, to be replaced by the SDK's once it has them. The client declares the extension and sends nothing of it to a server that does not offer it.
- **Within protocol 11.** A client of 0.13.0 asks for event routines (`routines.subscribe`'s `withEvents`); an older client is never sent one, and passes over their changes, which are entries of a new kind.

## Costs

- **An older app does not show event routines.** Routine triggers are a closed set in protocol 11, so a routine with a new trigger would make an older client refuse the whole list. The server leaves event routines out for it instead: the operator sees them once the app is updated, and their changes show as the line that asks for a newer version.
- **The Events extension is Beta.** Its text can change before it is final, and the module may need to follow it. That a real service delivers as the tests' fake server does is **Assumed**.
- **One listener per routine.** Two routines on the same event of one connector hold two subscriptions. Sharing one would save a request per event, at the cost of a subscription that outlives the routine that made it.
- **A burst can wait.** A routine past ten runs in a minute waits for the minute to pass, and an event that finds 100 already waiting is dropped, with the run told some were missed.
- **A webhook needs a public `https:` origin.** Without one, a stream or polling serves, which keeps a request open or asks every few seconds.
- **`list_changed` is not heard.** On the 2026-07-28 revision it reaches only a client listening on `subscriptions/listen`, which J3 Bots' stateless sessions do not hold. A removed event shows as the server ends its subscription, or as the listener lists the events again each time it starts over.

## Rejected

- **A bot subscribing from its own session.** A session is replaceable and a run happens in a side session of its own; a subscription held by either would end with it, and a bot would have to keep it alive. The server already holds what must survive a restart.
- **Waking the bot's main session for each event.** An event is the operator's standing request at work, which is what a routine's run is. A main-session wake per event would mix events into the conversation and pay a turn for each one the operator did not ask to hear about.
- **Showing event routines to an older client as a webhook.** It would load, and lie: the routine has no address, and the client would offer one.
- **A new protocol version.** It would lock out every older app for a trigger it can simply not be sent.
- **Waiting for the SDK.** Its support is a draft; the tap Tasks uses already carries requests the SDK does not know, and the module keeps the swap small.
