# Usage data

J3 Bots sends anonymous usage data so the people who build it can see how it is used and whether it works: which harnesses and models bots run on, whether their turns finish, whether updates land, which apps people open. It is on until you turn it off. Nothing you wrote, named or own is ever part of it. The decision behind it is [0099](../decisions/0099-usage-data-is-the-servers-typed-and-on-until-turned-off.md).

## Who sends it

Only your J3 Bots server sends it, to J3 Bots' project on PostHog (`us.i.posthog.com`). The web page, the desktop app and the Android app tell your server a few things only they see, such as that What's new was opened; they never send anything anywhere else.

T3 Code, the engine J3 Bots runs, has analytics of its own. J3 Bots always turns them off, whatever else you set.

## What is sent

Each event is one of a fixed list, and each of its details is one word from a fixed list, a yes or no, a rough count or a version number:

| Event | When | What it says |
| --- | --- | --- |
| `server.started` | The server starts | Only what every event says (below) |
| `install.active` | Once a day while the server runs | How many bots, active rooms, routines turned on and connectors you have, each as `0`, `1`, `2-3`, `4-10` or `11+` |
| `client.connected` | A device connects, once a day per device | Only what every event says |
| `message.sent` | You send a message | In a bot's conversation or a room; whether it mentions, replies, quotes or carries files |
| `turn.finished` | A bot's turn ends | The harness, the model by its public name, such as `claude-opus-4-5` (`custom` for any other, a gateway's included), the effort, what woke the bot, how the turn ended and why it failed, and how many seconds it took |
| `bot.created`, `room.created` | A bot or a room is made | The harness, or the number of members as a rough count; whether from a template; whether you or a bot made it |
| `routine.ran` | A routine's run ends | Whether it said something, stayed silent, failed, was skipped or stopped |
| `connector.added`, `connector.removed` | A connector is added or removed | From the catalog or your own; once removed, whether it had an app |
| `connector-app.shown` | A connector's app is shown | In the reply, full screen or pinned |
| `update.applied` | The server runs another release, or an update failed | The versions, and the kind of failure |
| `feature.used` | What's new is opened, or a message is dictated | Which of the two |
| `request.failed` | Something you asked for was refused | The kind of refusal and its code, never its message |

Every event also says which J3 Bots and engine versions run, the system family (Linux, macOS, Windows, Android), the processor family, and how the server runs (a service, the desktop app, by hand). An event a device caused also says which kind of device (web, desktop, quick access, Android), its system family and its app version.

Your install and each of your devices are told apart by a random number, made on that machine and sent only scrambled (as a SHA-256 hash). PostHog is told to make no profile and to look up no place from where the data came from.

## What is never sent

Messages, names, memory, files, paths, addresses, hostnames, IP addresses, emails, device names, ids of your bots, rooms or conversations, secrets and logins, what a connector or an app shows, and the text of any error. Every event is checked against its fixed list before it leaves, and anything that does not fit stays on your machine.

## See what is sent

In Settings → About and updates, **See what is sent** shows the last 100 events your server sent, exactly as they left.

## Turn it off

- **Settings → About and updates → Share anonymous usage data.** Off for the whole server, at once, from any of your devices. What was waiting to be sent is dropped.
- **`DO_NOT_TRACK=1`** in the server's environment keeps it off whatever the switch says.
- **`J3_TELEMETRY_ENABLED=false`** in the server's environment does the same.

A server run from a source checkout or on a CI runner sends nothing unless `J3_TELEMETRY_ENABLED=true`. Setting these variables for a server the installer set up is in [Operating: usage data](../operations/operating.md#usage-data).
